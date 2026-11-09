// Char Importer: library index. For every character: its source keys and
// content hash, cached in IndexedDB and refreshed from Marinara whenever a
// character's updatedAt changes. Marinara ids never change, so (unlike
// SillyTavern) renames need no handling; deleted ids are pruned on refresh.

const ciLib = (() => {
  "use strict";

  const CONCURRENCY = 6;
  // Above this many changed characters, page through the whole library instead of fetching one by one
  const BULK_THRESHOLD = 40;
  let index = null; // id -> entry
  // Bumped when entries gain fields, so the next refresh rebuilds them all once
  const SCHEMA = 2;
  let meta = { updated: 0, generation: null, schema: SCHEMA };
  let refreshing = null;

  function entryFor(row) {
    const data = row.data ?? {};
    const ext = data.extensions ?? {};
    return {
      name: typeof data.name === "string" ? data.name : "",
      keys: ciCore.keysFromCard(data),
      hash: ciCore.contentHash(data),
      updatedAt: row.updatedAt ?? "",
      created: Date.parse(row.createdAt ?? "") || 0,
      avatarPath: row.avatarPath ?? null,
      chubId: ext.chub?.id ?? null,
      obsolete: Array.isArray(ext.char_importer?.obsolete_keys) ? ext.char_importer.obsolete_keys.filter((k) => typeof k === "string") : [],
      uploader: ciCore.botbooruUploader(data),
      creator: ciCore.normName(data.creator),
      hasChubPack: ciCore.chubPacks(ext.chub).length > 0,
      fav: ext.fav === true,
    };
  }

  async function load() {
    if (index) return index;
    index = (await ciIdb.get("index")) ?? {};
    meta = (await ciIdb.get("indexMeta")) ?? meta;
    return index;
  }

  async function save() {
    await ciIdb.set("index", index);
    await ciIdb.set("indexMeta", meta);
  }

  /**
   * Brings the index up to date with Marinara.
   * @param {{full?: boolean, onProgress?: (text: string) => void, signal?: AbortSignal}} [options]
   *   full: re-read every character
   */
  function refresh(options = {}) {
    const previous = refreshing;
    if (previous && !options.full) return previous;
    const run = (previous ?? Promise.resolve()).catch(() => undefined).then(() => doRefresh(options));
    refreshing = run;
    run.then(
      () => refreshing === run && (refreshing = null),
      () => refreshing === run && (refreshing = null),
    );
    return run;
  }

  async function doRefresh({ full = false, onProgress, signal } = {}) {
    await load();
    onProgress?.("Reading the library...");
    const { items, generation } = await ciApi.listCatalog((n) => onProgress?.(`Reading the library... ${n}`));
    const live = new Map(items.map((item) => [item.id, item]));
    if (full || meta.schema !== SCHEMA) index = {};
    for (const id of Object.keys(index)) if (!live.has(id)) delete index[id];

    const stale = items.filter((item) => !index[item.id] || index[item.id].updatedAt !== item.updatedAt);
    let done = 0;
    const report = () => onProgress?.(`Scanning cards... ${done} / ${stale.length}`);

    if (stale.length > BULK_THRESHOLD) {
      const wanted = new Set(stale.map((s) => s.id));
      for await (const rows of ciApi.iterateCharacters()) {
        if (signal?.aborted) break;
        for (const row of rows) {
          if (!wanted.has(row.id)) continue;
          index[row.id] = entryFor(row);
          done++;
        }
        report();
      }
      // Rows added while paging, or skipped by offsets shifting
      const missed = stale.filter((s) => !index[s.id] || index[s.id].updatedAt !== s.updatedAt);
      await fetchEach(missed, () => {
        done++;
        report();
      }, signal);
    } else if (stale.length) {
      await fetchEach(stale, () => {
        done++;
        report();
      }, signal);
    }
    meta = { updated: Date.now(), generation, schema: SCHEMA };
    await save();
    return index;
  }

  async function fetchEach(list, onDone, signal) {
    const queue = [...list];
    const worker = async () => {
      while (queue.length && !signal?.aborted) {
        const item = queue.shift();
        try {
          const row = await ciApi.getCharacter(item.id);
          if (row) index[row.id] = entryFor(row);
        } catch (error) {
          if (!(error instanceof ciNet.HttpError && error.status === 404)) marinara.log.warn(`Could not read character ${item.id}`, error);
        }
        onDone();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  /** Index entry for one character after we changed it. */
  async function put(row) {
    await load();
    index[row.id] = entryFor(row);
    await save();
    return index[row.id];
  }

  async function remove(id) {
    await load();
    delete index[id];
    await save();
  }

  /**
   * Sets of every key and hash in the library, with the id that has each.
   * @returns {Promise<{keys: Map<string, string>, hashes: Map<string, string>}>}
   */
  async function existing() {
    await load();
    const keys = new Map();
    const hashes = new Map();
    for (const [id, entry] of Object.entries(index)) {
      for (const key of entry.keys ?? []) if (!keys.has(key)) keys.set(key, id);
      if (entry.hash && !hashes.has(entry.hash)) hashes.set(entry.hash, id);
    }
    return { keys, hashes };
  }

  /** Lowercase "creator/slug" of every Chub character. */
  async function ownedChubPaths() {
    await load();
    const paths = new Set();
    for (const entry of Object.values(index)) for (const key of entry.keys ?? []) if (key.startsWith("chub:")) paths.add(key.slice(5));
    return [...paths];
  }

  /** Post IDs of every Botbooru character. */
  async function ownedBotbooruIds() {
    await load();
    const ids = new Set();
    for (const entry of Object.values(index)) for (const key of entry.keys ?? []) if (key.startsWith("botbooru:")) ids.add(key.slice(9));
    return [...ids];
  }

  async function status() {
    await load();
    const entries = Object.values(index);
    return {
      count: entries.length,
      withKeys: entries.filter((e) => e.keys?.length).length,
      withHash: entries.filter((e) => e.hash).length,
      updated: meta.updated,
    };
  }

  // ── Owned list for the companion userscript (hides owned cards on Chub and Botbooru) ──
  // Same events as Dupe Link Skip, so one userscript serves both apps.

  let publishTimer = 0;
  let savedOwnedKey = null;
  // Leaves room in marinara.storage (1 MB in all) for settings
  const MAX_SAVED_OWNED_BYTES = 600_000;

  /** Saves the list server side, so the userscript in another browser can fetch it. */
  async function saveOwned(paths, botbooru) {
    const key = `${[...paths].sort().join("\n")}\n#${[...botbooru].sort().join(",")}`;
    if (key === savedOwnedKey) return;
    const value = { paths, botbooru, updated: Date.now() };
    if (JSON.stringify(value).length > MAX_SAVED_OWNED_BYTES) {
      marinara.log.warn(`Owned Chub list too large to save for other browsers (${paths.length} cards)`);
      return;
    }
    await marinara.storage.patch({ ownedChub: value });
    savedOwnedKey = key;
  }

  async function publishOwned() {
    try {
      const paths = await ownedChubPaths();
      // Botbooru post IDs ride along; SillyTavern's extension doesn't send or read them
      const botbooru = await ownedBotbooruIds();
      window.dispatchEvent(
        new CustomEvent("dupelinkskip:owned", {
          detail: JSON.stringify({ paths, botbooru, updated: Date.now(), app: "marinara", origin: location.origin }),
        }),
      );
      await saveOwned(paths, botbooru);
    } catch (error) {
      marinara.log.warn("Could not publish the owned Chub list", error);
    }
  }

  const syncAddress = () => `${location.origin}/api/personal-extensions/${encodeURIComponent(marinara.extension.id)}/storage`;
  // Not reset by later calls, so a running import queue still publishes every few seconds
  function publishOwnedSoon() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = 0;
      void publishOwned();
    }, 3000);
  }
  const onOwnedRequest = () => void publishOwned();
  window.addEventListener("dupelinkskip:request", onOwnedRequest);

  function dispose() {
    clearTimeout(publishTimer);
    window.removeEventListener("dupelinkskip:request", onOwnedRequest);
  }

  const get = () => index ?? {};

  return Object.freeze({ load, refresh, put, remove, existing, ownedChubPaths, ownedBotbooruIds, status, get, entryFor, publishOwned, publishOwnedSoon, syncAddress, dispose });
})();
