// Char Importer: the import queue. Links run one at a time in the order
// added; each keeps the options of the dialog it came from. The queue is
// saved after every step, so a reload can pick up where it stopped: a
// character that was saved before the reload only gets its assets finished.

const ciQueue = (() => {
  "use strict";

  /** @typedef {{url: string, opts: object, state: "pending"|"running"|"done"|"warn"|"skipped"|"failed", note: string, interrupted?: boolean, charId?: string, name?: string}} QueueItem */
  const queue = { items: [], running: false, stop: false, paused: false, step: "" };
  const listeners = new Set();
  let writeChain = Promise.resolve();
  let controller = null;
  // Set when the extension is unloaded: the saved queue is left as it was, so the next load resumes it
  let disposed = false;

  const notify = () => {
    for (const fn of listeners) {
      try {
        fn(queue);
      } catch (error) {
        marinara.log.warn("Queue listener failed", error);
      }
    }
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  function save() {
    if (disposed) return writeChain;
    const items = queue.items.map(({ url, opts, state, note, interrupted, charId, name }) => ({ url, opts, state, note, interrupted, charId, name }));
    writeChain = writeChain.then(() => ciIdb.set("importQueue", items)).catch((error) => marinara.log.error("Could not save the import queue", error));
    return writeChain;
  }

  /** After a reload: links the last session didn't finish, paused until Resume or Dismiss. */
  async function restore() {
    const items = (await ciIdb.get("importQueue")) ?? [];
    if (!items.some((i) => i.state === "pending" || i.state === "running")) {
      if (items.length) await ciIdb.del("importQueue");
      return false;
    }
    for (const item of items) {
      if (item.state === "running") {
        item.state = "pending";
        item.note = "Interrupted by reload";
        item.interrupted = true;
      }
    }
    queue.items = items;
    queue.paused = true;
    notify();
    return true;
  }

  /**
   * Adds links. Links already waiting or running are left out.
   * @returns {{added: number, alreadyQueued: number, joined: boolean}}
   */
  function add(links, opts) {
    const active = new Set(queue.items.filter((i) => i.state === "pending" || i.state === "running").map((i) => i.url));
    let added = 0;
    for (const url of links) {
      if (active.has(url)) continue;
      active.add(url);
      queue.items.push({ url, opts: { ...opts }, state: "pending", note: "" });
      added++;
    }
    const joined = queue.running;
    void save();
    notify();
    if (!queue.running && added) void run();
    return { added, alreadyQueued: links.length - added, joined };
  }

  function stopAfterCurrent() {
    if (queue.running) queue.stop = true;
    notify();
  }

  /** Stop now: aborts the current download. */
  function abort() {
    queue.stop = true;
    controller?.abort();
    notify();
  }

  function resume() {
    if (!queue.running) void run();
  }

  function dismiss() {
    for (const item of queue.items.filter((i) => i.state === "pending")) {
      item.state = "skipped";
      item.note = "Dismissed";
      delete item.interrupted;
    }
    queue.paused = false;
    if (!queue.running) queue.items = [];
    void save();
    notify();
  }

  function clearFinished() {
    queue.items = queue.items.filter((i) => i.state === "pending" || i.state === "running");
    void save();
    notify();
  }

  const isRunning = () => queue.running;
  const get = () => queue;

  function assetOptions(opts) {
    return { expressions: !!opts.downloadExpressions, localize: !!opts.localizeAssets, lorebooks: !!opts.downloadLorebooks, links: true };
  }

  /**
   * Imports one link.
   * @returns {Promise<"link"|"content"|null>} why it was skipped as a duplicate, if it was
   */
  async function importItem(item, existing, signal, wasInterrupted) {
    const { url, opts } = item;
    const setStep = (text) => {
      item.note = text;
      queue.step = text;
      notify();
    };
    const finish = (state, note) => {
      item.state = state;
      item.note = note;
    };

    let plan;
    try {
      plan = ciSources.resolve(url);
    } catch (error) {
      finish("failed", ciNet.describe(error));
      return null;
    }
    const key = plan.key;
    const lookup = (map, k) => {
      const id = k && map.get(k);
      return id ? (ciLib.get()[id]?.name || "a character") : null;
    };

    // Cut off by a reload: Marinara may have saved the character before its assets were done
    if (wasInterrupted && plan.kind === "character") {
      const id = item.charId ?? existing.keys.get(key);
      const row = id ? await ciApi.getCharacter(id).catch(() => null) : null;
      if (row) {
        item.charId = row.id;
        item.name = row.data.name;
        const result = await ciAssets.importAssets(row.id, row.data, { ...assetOptions(opts), signal, onStep: setStep });
        ciApi.refreshMarinara(["characters", "sprites", "gallery", "lorebooks"]);
        if (result.warnings.length) finish("warn", `${row.data.name} was imported before the reload; ${result.warnings.join("; ")}`);
        else finish("done", `${row.data.name} was imported before the reload; assets finished`);
        return null;
      }
    }

    if (plan.kind === "lorebook") {
      setStep("Importing lorebook");
      const result = await ciAssets.importLorebookLink(plan.id, signal);
      ciApi.refreshMarinara(["lorebooks"]);
      finish("done", result.reused ? `Lorebook ${result.name} is already in Marinara` : `Lorebook ${result.name} imported`);
      return null;
    }

    if (opts.preventDuplicates && existing.keys.has(key)) {
      finish("skipped", `Duplicate link (${lookup(existing.keys, key)})`);
      return "link";
    }

    setStep("Downloading card");
    const loaded = await ciSources.load(plan, { signal });
    if (loaded.type === "lorebook") {
      setStep("Importing lorebook");
      const result = await ciApi.importLorebook(loaded.json, loaded.name);
      ciApi.refreshMarinara(["lorebooks"]);
      finish("done", `Lorebook ${result.name ?? loaded.name} imported`);
      return null;
    }

    const hash = ciCore.contentHash(loaded.card);
    if (opts.preventDuplicates && opts.contentCheck && hash && existing.hashes.has(hash)) {
      finish("skipped", `Identical card already in the library (${lookup(existing.hashes, hash)})`);
      return "content";
    }

    setStep("Importing");
    const marker = { v: 1, source_key: key, source_url: url, content_hash: hash || undefined, imported_at: new Date().toISOString() };
    let card = ciSources.withMarker(loaded.card, marker);
    const importOptions = {
      importEmbeddedLorebook: opts.importEmbeddedLorebook !== false,
      tagImportMode: opts.tagImportMode ?? "all",
      regexScriptScope: opts.regexScriptScope ?? "character",
      splitDescription: !!opts.splitDescription,
    };
    const tagNotes = [];
    let merged = null;
    if (opts.tagMerge) {
      const { target } = ciSources.editable(card);
      merged = await ciTags.finalTags(target.tags, importOptions.tagImportMode);
      if (!merged) tagNotes.push("Tag Merger isn't enabled, so tags weren't merged");
    }
    let result;
    if (loaded.charx) {
      // Marinara unpacks the .charx (card, avatar, assets); the marker (and merged tags) go on afterwards
      result = await ciApi.importCharacterFile(loaded.charx, "card.charx", importOptions);
      const patch = { extensions: { char_importer: marker } };
      if (merged) patch.tags = merged.tags;
      await ciApi.updateCharacter(result.characterId, patch, { skipVersionSnapshot: true });
    } else {
      if (merged) {
        // Tags are final already; "all" stops Marinara filtering them again
        const { card: tagged, target } = ciSources.editable(card);
        target.tags = merged.tags;
        card = tagged;
        importOptions.tagImportMode = "all";
      }
      if (loaded.avatarDataUrl) importOptions._avatarDataUrl = loaded.avatarDataUrl;
      if (loaded.botBrowserSource) importOptions._botBrowserSource = loaded.botBrowserSource;
      result = await ciApi.importCharacter(card, importOptions);
    }
    item.charId = result.characterId;
    item.name = result.name;
    // From here on a reload resumes with the assets
    await save();

    existing.keys.set(key, result.characterId);
    if (hash) existing.hashes.set(hash, result.characterId);
    const row = await ciApi.getCharacter(result.characterId);
    const entry = await ciLib.put(row);
    for (const k of entry.keys) if (!existing.keys.has(k)) existing.keys.set(k, row.id);
    ciApi.refreshMarinara(["characters", "lorebooks"]);

    const assets = await ciAssets.importAssets(row.id, row.data, { ...assetOptions(opts), signal, onStep: setStep });
    ciApi.refreshMarinara(["characters", "sprites", "gallery", "lorebooks"]);
    const name = result.name || row.data.name;
    if (merged) {
      ciTags.add(merged.tags);
      if (merged.merged) assets.summary.push(`${merged.merged} tag${merged.merged === 1 ? "" : "s"} merged to canonicals`);
    }
    assets.warnings.push(...tagNotes);
    const extra = assets.summary.length ? ` (${assets.summary.join(", ")})` : "";
    if (assets.warnings.length) finish("warn", `Imported ${name}${extra}; ${assets.warnings.join("; ")}`);
    else finish("done", `Imported ${name}${extra}`);
    return null;
  }

  async function run() {
    if (queue.running) return;
    queue.running = true;
    queue.stop = false;
    queue.paused = false;
    controller = new AbortController();
    notify();
    const skippedLinks = [];
    const skippedContent = [];
    let existing = null;
    try {
      queue.step = "Reading the library";
      notify();
      ciTags.reset();
      // Catches characters saved after a reload, and anything added outside this queue
      await ciLib.refresh({ onProgress: (text) => ((queue.step = text), notify()) });
      existing = await ciLib.existing();
      let item;
      while (!queue.stop && (item = queue.items.find((i) => i.state === "pending"))) {
        // Set while it runs, so after a reload it is known to have been cut off
        const wasInterrupted = !!item.interrupted;
        item.state = "running";
        item.note = "";
        item.interrupted = true;
        notify();
        await save();
        try {
          const skipped = await importItem(item, existing, controller.signal, wasInterrupted);
          if (skipped === "link") skippedLinks.push(item.url);
          if (skipped === "content") skippedContent.push(item.url);
        } catch (error) {
          if (error?.name === "AbortError") {
            item.state = "failed";
            item.note = "Stopped";
          } else {
            marinara.log.error(`Import failed for ${item.url}`, error);
            item.state = "failed";
            item.note = ciNet.describe(error);
          }
        }
        delete item.interrupted;
        notify();
        await save();
      }
      for (const rest of queue.items.filter((i) => i.state === "pending")) {
        rest.state = "skipped";
        rest.note = "Stopped";
        delete rest.interrupted;
      }
    } catch (error) {
      marinara.log.error("Import queue failed", error);
      ciDom.toast(`Import queue stopped: ${ciNet.describe(error)}`, "error");
      for (const rest of queue.items.filter((i) => i.state === "pending")) {
        rest.state = "failed";
        rest.note = ciNet.describe(error);
      }
    } finally {
      queue.running = false;
      queue.stop = false;
      queue.step = "";
      controller = null;
      notify();
      await save();
    }
    ciLib.publishOwnedSoon();
    const parts = [];
    if (skippedLinks.length) parts.push(`${skippedLinks.length} duplicate link${skippedLinks.length === 1 ? "" : "s"}`);
    if (skippedContent.length) parts.push(`${skippedContent.length} identical card${skippedContent.length === 1 ? "" : "s"}`);
    if (parts.length) ciDom.toast(`Skipped ${parts.join(" and ")}.`, "info");
  }

  function dispose() {
    disposed = true;
    queue.stop = true;
    controller?.abort();
    listeners.clear();
  }

  return Object.freeze({ dispose, subscribe, restore, add, stopAfterCurrent, abort, resume, dismiss, clearFinished, isRunning, get });
})();
