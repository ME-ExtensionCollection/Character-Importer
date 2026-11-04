// Char Importer: everything after the card itself. Chub expression packs into
// Marinara sprite folders, the Chub gallery, linked Chub lorebooks, images in
// the card text saved locally, and asset links in creator notes. Also the
// library-wide Fetch assets and Retry failed images jobs.

const ciAssets = (() => {
  "use strict";

  const GALLERY_BATCH = 10; // Marinara's bake limit per request
  const TEXT_FIELDS = ["description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions"];
  // Fields shown with the speaking character's context, where card://self resolves.
  // Elsewhere (creator notes) the reference names the character explicitly.
  const SELF_FIELDS = new Set(["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions"]);
  const GREETING_FIELDS = new Set(["first_mes"]);

  // Same image forms Marinara renders (shared/src/utils/greeting-image-bake.ts)
  const MARKDOWN_IMAGE_RE = /(!\[[^[\]]*\]\()(https?:\/\/[^()[\]\s]+)(\))/g;
  const HTML_IMAGE_RE = /(<img\b[^<>]*?\ssrc\s*=\s*)(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)'|(https?:\/\/[^\s>"'`]+))/gi;

  function rewriteImageUrls(text, replace) {
    return text
      .replace(MARKDOWN_IMAGE_RE, (match, open, url, close) => {
        const next = replace(url);
        return next === undefined ? match : `${open}${next}${close}`;
      })
      .replace(HTML_IMAGE_RE, (match, prefix, double, single, bare) => {
        const raw = double ?? single ?? bare ?? "";
        const next = replace(raw.replace(/&amp;/gi, "&"));
        if (next === undefined) return match;
        const quote = single !== undefined ? "'" : '"';
        return `${prefix}${quote}${next}${quote}`;
      });
  }

  function imageUrlsIn(text) {
    const urls = [];
    if (typeof text !== "string") return urls;
    rewriteImageUrls(text, (url) => {
      if (!urls.includes(url)) urls.push(url);
      return undefined;
    });
    return urls;
  }

  /** Web image URLs in a card's text fields and alternate greetings. */
  function cardImageUrls(data) {
    const urls = new Set();
    for (const field of TEXT_FIELDS) for (const url of imageUrlsIn(data[field])) urls.add(url);
    for (const g of Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []) for (const url of imageUrlsIn(g)) urls.add(url);
    return [...urls];
  }

  const selfRef = (file) => `card://self/gallery/${encodeURIComponent(file)}`;
  const charRef = (id, file) => `card://characters/${encodeURIComponent(id)}/gallery/${encodeURIComponent(file)}`;
  const fileOf = (row) => String(row?.filePath ?? "").replace(/\\/g, "/").split("/").pop();

  const marker = (data) => data?.extensions?.char_importer ?? {};
  /** The card's char_importer block with the content hash pinned, so later edits don't change what it matches. */
  const pinnedMarker = (data, extra) => ({ ...marker(data), content_hash: ciCore.savedHash(data) || ciCore.contentHash(data, { ignoreSaved: true }), ...extra });

  // ── Per-character records in IndexedDB ──

  const recordOf = (store) => ({
    get: async (id) => ((await ciIdb.get(store)) ?? {})[id],
    all: async () => (await ciIdb.get(store)) ?? {},
    set: (id, value) =>
      ciIdb.update(store, (map) => {
        if (value === undefined || value === null || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) delete map[id];
        else map[id] = value;
      }),
    patch: (id, patch) => ciIdb.update(store, (map) => void (map[id] = { ...(map[id] ?? {}), ...patch })),
    remove: (ids) => ciIdb.update(store, (map) => void ids.forEach((id) => delete map[id])),
  });
  const failuresStore = recordOf("imageFailures"); // id -> {url: {t, reason}}
  const linksStore = recordOf("assetLinks"); // id -> [{url, context}]
  const checkedStore = recordOf("assetsChecked"); // id -> {expressions, gallery, lorebooks, images, links: time}
  const packsStore = recordOf("packs"); // id -> {folders: [folder name | null]}
  const hashStore = recordOf("galleryHashes"); // id -> {file: sha1}

  // ── Gallery ──

  /** The character's gallery rows and their content hashes (cached by file name). */
  async function galleryState(charId) {
    const rows = await ciApi.listGallery(charId);
    const cached = (await hashStore.get(charId)) ?? {};
    const hashes = {};
    const byHash = new Map();
    const byFile = new Map();
    for (const row of rows) {
      const file = fileOf(row);
      byFile.set(file, row);
      let hash = cached[file];
      if (!hash) {
        try {
          hash = await ciPng.sha1Hex((await ciApi.readBytes(row.url)).bytes);
        } catch {
          continue;
        }
      }
      hashes[file] = hash;
      if (!byHash.has(hash)) byHash.set(hash, file);
    }
    await hashStore.set(charId, hashes);
    return { rows, byFile, byHash, hashes };
  }

  /**
   * Checks a freshly added gallery file: if the gallery already had the same
   * image, the new copy is removed and the old file name returned.
   */
  async function dedupeNewFile(charId, file, state) {
    let row = state.byFile.get(file);
    if (!row) {
      const rows = await ciApi.listGallery(charId);
      row = rows.find((r) => fileOf(r) === file);
      if (row) state.byFile.set(file, row);
    }
    if (!row) return { file, isNew: true };
    const hash = await ciPng.sha1Hex((await ciApi.readBytes(row.url)).bytes);
    const existing = state.byHash.get(hash);
    if (existing && existing !== file) {
      await ciApi.deleteGalleryImage(charId, row.id).catch((error) => marinara.log.warn("Could not remove a duplicate gallery copy", error));
      state.byFile.delete(file);
      return { file: existing, isNew: false };
    }
    state.byHash.set(hash, file);
    state.hashes[file] = hash;
    return { file, isNew: true };
  }

  async function uploadBytes(charId, url, state, signal) {
    const { bytes, contentType } = await ciNet.fetchRemote(url, { signal, accept: "image/*", timeoutMs: 30_000 });
    const mime = ciPng.sniffImageType(bytes) || contentType.split(";")[0];
    const ext = ciPng.extensionFor(mime);
    if (!ext) throw new Error("Not an image");
    const hash = await ciPng.sha1Hex(bytes);
    const existing = state.byHash.get(hash);
    if (existing) return { file: existing, isNew: false };
    let row;
    try {
      row = await ciApi.uploadGallery(charId, bytes, `image.${ext}`, mime);
    } catch (error) {
      throw new ciNet.LocalSaveError(`Marinara could not store the image: ${ciNet.describe(error)}`);
    }
    const file = fileOf(row) || row?.filename;
    if (!file) throw new ciNet.LocalSaveError("Marinara stored the image but returned no file name");
    state.byHash.set(hash, file);
    state.hashes[file] = hash;
    if (row?.id) state.byFile.set(file, row);
    return { file, isNew: true };
  }

  /**
   * Saves web images into a character's gallery. Marinara's server downloads
   * them (no CORS problem); what it refuses is fetched here and uploaded.
   * Copies of images the gallery already has are dropped.
   * @returns {Promise<{saved: Record<string,string>, failures: Record<string,{t:number,reason:string}>, added: number}>}
   */
  async function saveImages(charId, urls, { signal, onProgress, state } = {}) {
    state ??= await galleryState(charId);
    const saved = {};
    const failures = {};
    let added = 0;
    let done = 0;
    const pending = urls.filter((url) => {
      if (!ciNet.isHostDown(url)) return true;
      failures[url] = { t: Date.now(), reason: `${ciNet.hostOf(url)} is being skipped after repeated failures` };
      return false;
    });
    for (let i = 0; i < pending.length; i += GALLERY_BATCH) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const batch = pending.slice(i, i + GALLERY_BATCH);
      let results;
      for (;;) {
        try {
          results = (await ciApi.bakeGallery(charId, batch)).results ?? [];
          break;
        } catch (error) {
          if (!(error instanceof ciNet.RateLimitError)) throw new ciNet.LocalSaveError(`Marinara could not save images: ${ciNet.describe(error)}`);
          onProgress?.(done, pending.length, "waiting for Marinara's rate limit");
          await ciNet.sleep(error.retryAfterMs, signal);
        }
      }
      for (const url of batch) {
        const result = results.find((r) => r.url === url);
        try {
          let outcome;
          if (result?.file) outcome = await dedupeNewFile(charId, result.file, state);
          else outcome = await uploadBytes(charId, url, state, signal);
          saved[url] = outcome.file;
          if (outcome.isNew) added++;
          ciNet.noteResult(url, true);
        } catch (error) {
          if (signal?.aborted || error instanceof ciNet.LocalSaveError || error instanceof ciNet.RateLimitError) throw error;
          failures[url] = { t: Date.now(), reason: result?.error ? `${result.error}; ${ciNet.describe(error)}` : ciNet.describe(error) };
        }
        onProgress?.(++done, pending.length);
      }
    }
    await hashStore.set(charId, state.hashes);
    return { saved, failures, added };
  }

  /**
   * Image bytes for sprites: direct, then through a temporary gallery copy
   * (Marinara's server downloads it), then the userscript.
   */
  async function fetchImageBytes(url, charId, signal) {
    try {
      return (await ciNet.fetchRemote(url, { signal, accept: "image/*", noBridge: true, timeoutMs: 30_000 })).bytes;
    } catch (error) {
      if (!(error instanceof ciNet.BlockedError)) throw error;
    }
    if (ciSettings.get().serverImageProxy && charId) {
      try {
        const result = (await ciApi.bakeGallery(charId, [url])).results?.[0];
        if (result?.file) {
          const rows = await ciApi.listGallery(charId);
          const row = rows.find((r) => fileOf(r) === result.file);
          if (row) {
            await ciIdb.update("tempGallery", (map) => void (map[row.id] = charId));
            try {
              return (await ciApi.readBytes(row.url)).bytes;
            } finally {
              await ciApi.deleteGalleryImage(charId, row.id).catch(() => undefined);
              await ciIdb.update("tempGallery", (map) => void delete map[row.id]);
            }
          }
        }
      } catch (error) {
        if (error instanceof ciNet.RateLimitError) await ciNet.sleep(error.retryAfterMs, signal);
      }
    }
    return (await ciNet.fetchRemote(url, { signal, accept: "image/*", timeoutMs: 30_000 })).bytes;
  }

  /** Removes temporary gallery copies left by an interrupted sprite download. */
  async function cleanupTempGallery() {
    const map = (await ciIdb.get("tempGallery")) ?? {};
    for (const [imageId, charId] of Object.entries(map)) {
      await ciApi.deleteGalleryImage(charId, imageId).catch(() => undefined);
    }
    if (Object.keys(map).length) await ciIdb.set("tempGallery", {});
  }

  // ── Chub expressions -> sprites ──

  /** Folder id for a sprite folder name, created if needed. */
  async function ensureFolder(charId, name) {
    const find = (catalog) => catalog.folders?.find((f) => f.category === "expressions" && f.name.toLowerCase() === name.toLowerCase());
    let folder = find(await ciApi.spriteCatalog(charId));
    if (folder) return folder.id;
    try {
      folder = find(await ciApi.createSpriteFolder(charId, name));
    } catch (error) {
      if (!(error instanceof ciNet.HttpError && error.status === 409)) throw error;
      folder = find(await ciApi.spriteCatalog(charId));
    }
    if (!folder) throw new ciNet.LocalSaveError(`Could not create sprite folder ${name}`);
    return folder.id;
  }

  async function hashSprites(sprites) {
    const hashes = new Set();
    for (const sprite of sprites) {
      try {
        hashes.add(await ciPng.sha1Hex((await ciApi.readBytes(sprite.url)).bytes));
      } catch {
        // unreadable sprite; ignore
      }
    }
    return hashes;
  }

  /**
   * Downloads a Chub character's expression packs. The default pack goes in
   * unfiled when the character has no sprites yet (that is the set Marinara
   * shows), otherwise into folder "Chub"; alternate packs into "Chub - <name>".
   * Labels that already exist are never overwritten.
   * @returns {Promise<number>} sprites written
   */
  async function importExpressions(charId, chub, { signal, onProgress, gap = 0 } = {}) {
    const packs = ciCore.chubPacks(chub);
    if (!packs.length) return 0;
    const total = packs.reduce((sum, { pack }) => sum + ciCore.packEntries(pack).length, 0);
    if (!total) return 0;
    let done = 0;
    onProgress?.(done, total);

    const record = (await packsStore.get(charId)) ?? { folders: [] };
    const own = new Set(record.folders);
    const remember = async (name) => {
      if (own.has(name)) return;
      own.add(name);
      await packsStore.set(charId, { folders: [...own] });
    };

    const sprites = await ciApi.listSprites(charId);
    const knownHashes = await hashSprites(sprites);
    // Unfiled sprites that didn't come from an earlier run of this import belong to someone else
    const rootTaken = sprites.some((s) => !s.folderId) && !own.has(null);
    let written = 0;

    for (const { pack, sub } of packs) {
      const entries = ciCore.packEntries(pack);
      if (!entries.length) continue;
      const folderName = sub ? `Chub - ${String(sub).slice(0, 90)}` : rootTaken ? "Chub" : null;
      const folderId = folderName ? await ensureFolder(charId, folderName) : null;
      const inFolder = (await ciApi.listSprites(charId)).filter((s) => (s.folderId ?? null) === folderId);
      const taken = new Set(inFolder.map((s) => String(s.label ?? s.expression).toLowerCase()));
      // Packs reuse one image for several labels, so only skip images that came from elsewhere
      const ownHashes = own.has(folderName) ? await hashSprites(inFolder) : new Set();

      for (const [label, url] of entries) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        onProgress?.(done++, total);
        if (taken.has(label.toLowerCase())) continue;
        let bytes;
        try {
          bytes = await fetchImageBytes(url, charId, signal);
        } catch (error) {
          if (error instanceof ciNet.RateLimitError || signal?.aborted) throw error;
          marinara.log.warn(`Sprite ${label} could not be downloaded`, error);
          continue;
        }
        if (gap) await ciNet.sleep(gap, signal);
        const mime = ciPng.sniffImageType(bytes);
        if (!mime) continue;
        const hash = await ciPng.sha1Hex(bytes);
        if (knownHashes.has(hash) && !ownHashes.has(hash)) continue;
        // Recorded before writing, so an interrupted download resumes into the same folder
        await remember(folderName);
        let result;
        try {
          result = await ciApi.uploadSprite(charId, { expression: label, image: ciPng.toDataUrl(bytes, mime), folderId });
        } catch (error) {
          throw new ciNet.LocalSaveError(`Marinara could not store sprite ${label}: ${ciNet.describe(error)}`);
        }
        taken.add(label.toLowerCase());
        if (!result) continue;
        ownHashes.add(hash);
        knownHashes.add(hash);
        written++;
      }
    }
    onProgress?.(total, total);
    return written;
  }

  // ── Chub gallery ──

  async function fetchChubGallery(projectId, signal) {
    const urls = [];
    for (let page = 1; page <= 10; page++) {
      let data;
      try {
        data = await ciNet.fetchRemoteJson(`https://api.chub.ai/api/gallery/project/${encodeURIComponent(projectId)}?nsfw=true&page=${page}&limit=50`, { signal });
      } catch (error) {
        if (error instanceof ciNet.HttpError && error.status === 404) break;
        throw error;
      }
      const nodes = data?.nodes ?? data?.data?.nodes ?? data?.data ?? (Array.isArray(data) ? data : []);
      if (!Array.isArray(nodes) || !nodes.length) break;
      for (const node of nodes) {
        const url =
          node?.primary_image_path ?? node?.image_url ?? node?.url ??
          Object.values(node ?? {}).find((v) => typeof v === "string" && /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?|$)/i.test(v));
        if (url && !urls.includes(url)) urls.push(url);
      }
      if (nodes.length < 50) break;
      await ciNet.sleep(1000, signal);
    }
    return urls;
  }

  /**
   * Chub gallery into the character's gallery. URLs saved before are skipped
   * even if the file was deleted since, so removed pictures stay removed.
   * @returns {Promise<{added: number, data: object}>}
   */
  async function importChubGallery(charId, data, { signal, onProgress } = {}) {
    const projectId = data.extensions?.chub?.id;
    if (!projectId) return { added: 0, data };
    const urls = await fetchChubGallery(projectId, signal);
    const savedUrls = { ...(marker(data).gallery ?? {}) };
    const pending = urls.filter((url) => !savedUrls[url]);
    if (!pending.length) return { added: 0, data };
    let result = { saved: {}, failures: {}, added: 0 };
    try {
      result = await saveImages(charId, pending, { signal, onProgress });
    } finally {
      Object.assign(savedUrls, result.saved);
      if (Object.keys(result.saved).length) {
        const row = await ciApi.updateCharacter(charId, { extensions: { char_importer: pinnedMarker(data, { gallery: savedUrls }) } }, { skipVersionSnapshot: true });
        data = row?.data ?? data;
      }
    }
    return { added: result.added, data };
  }

  // ── Chub lorebooks ──

  /**
   * Downloads the lorebooks a Chub card links to and links them to the
   * character. Each book is downloaded once and shared by later characters.
   * @returns {Promise<number>} lorebooks downloaded
   */
  async function importChubLorebooks(charId, data, { signal, onProgress } = {}) {
    const related = data.extensions?.chub?.related_lorebooks;
    if (!Array.isArray(related) || !related.length) return 0;
    const known = { ...ciSettings.get().lorebooks };
    let added = 0;
    for (const [i, book] of related.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      onProgress?.(i, related.length);
      const path = String(book?.path ?? "").replace(/^\/?lorebooks\//, "");
      if (!path.includes("/")) continue;
      const key = path.toLowerCase();
      let lorebookId = known[key];
      if (lorebookId && !(await ciApi.getLorebook(lorebookId))) lorebookId = null;
      if (!lorebookId) {
        const { json, name } = await ciSources.loadChubLorebook(path, signal);
        lorebookId = (await ciApi.importLorebook(json, name)).lorebookId;
        known[key] = lorebookId;
        ciSettings.set({ lorebooks: known });
        added++;
        await ciNet.sleep(1000, signal);
      }
      await ciApi.linkLorebook(lorebookId, charId);
    }
    onProgress?.(related.length, related.length);
    return added;
  }

  /** Imports a pasted Chub lorebook link (or reuses it). @returns {Promise<{lorebookId: string, reused: boolean, name: string}>} */
  async function importLorebookLink(path, signal) {
    const key = path.toLowerCase();
    const known = { ...ciSettings.get().lorebooks };
    if (known[key]) {
      const book = await ciApi.getLorebook(known[key]);
      if (book) return { lorebookId: known[key], reused: true, name: book.name ?? path };
    }
    const { json, name } = await ciSources.loadChubLorebook(path, signal);
    const lorebookId = (await ciApi.importLorebook(json, name)).lorebookId;
    known[key] = lorebookId;
    ciSettings.set({ lorebooks: known });
    return { lorebookId, reused: false, name };
  }

  // ── Images in the card text ──

  /**
   * Saves images linked in the card text to the gallery and points the text
   * at the local copies (card://self/gallery/... where Marinara resolves it,
   * card://characters/<id>/gallery/... in creator notes). Greetings also get
   * Marinara's bakedGreetingImages record, so compatible exports restore the
   * web links. The mapping lives in extensions.char_importer.images.
   * @returns {Promise<{saved: number, failed: number, data: object}>}
   */
  async function localizeImages(charId, data, { signal, onProgress } = {}) {
    const urls = cardImageUrls(data);
    if (!urls.length) {
      await failuresStore.set(charId, null);
      return { saved: 0, failed: 0, data };
    }
    const state = await galleryState(charId);
    const savedUrls = marker(data).images ?? {};
    const local = {};
    const toFetch = [];
    for (const url of urls) {
      if (savedUrls[url] && state.byFile.has(savedUrls[url])) local[url] = savedUrls[url];
      else toFetch.push(url);
    }
    let failures = {};
    let downloaded = 0;
    if (toFetch.length) {
      const result = await saveImages(charId, toFetch, { signal, onProgress, state });
      Object.assign(local, result.saved);
      failures = result.failures;
      downloaded = Object.keys(result.saved).length;
    }
    await failuresStore.set(charId, failures);
    if (!Object.keys(local).length) return { saved: 0, failed: Object.keys(failures).length, data };

    const changes = {};
    const greetingImages = [];
    const rewriteField = (field, text) =>
      rewriteImageUrls(text, (url) => {
        const file = local[url];
        if (!file) return undefined;
        if (GREETING_FIELDS.has(field)) greetingImages.push({ file, url });
        return SELF_FIELDS.has(field) ? selfRef(file) : charRef(charId, file);
      });
    for (const field of TEXT_FIELDS) {
      if (typeof data[field] !== "string") continue;
      const updated = rewriteField(field, data[field]);
      if (updated !== data[field]) changes[field] = updated;
    }
    if (Array.isArray(data.alternate_greetings)) {
      const next = data.alternate_greetings.map((g) => (typeof g === "string" ? rewriteField("first_mes", g) : g));
      if (next.some((g, i) => g !== data.alternate_greetings[i])) changes.alternate_greetings = next;
    }
    const extensions = { char_importer: pinnedMarker(data, { images: { ...savedUrls, ...local } }) };
    if (greetingImages.length) {
      const previous = Array.isArray(data.extensions?.bakedGreetingImages) ? data.extensions.bakedGreetingImages : [];
      extensions.bakedGreetingImages = [...new Map([...previous, ...greetingImages].map((e) => [e.url, e])).values()];
    }
    const changedText = Object.keys(changes).length > 0;
    const row = await ciApi.updateCharacter(
      charId,
      { ...changes, extensions },
      changedText ? { versionReason: "Saved card images locally" } : { skipVersionSnapshot: true },
    );
    return { saved: downloaded, failed: Object.keys(failures).length, data: row?.data ?? data };
  }

  /** Web images still linked in the card text (not saved yet). */
  const pendingImages = (data) => cardImageUrls(data);

  // ── Asset links ──

  async function flagAssetLinks(charId, data) {
    const s = ciSettings.get();
    const found = ciCore.findAssetLinks(data.creator_notes, s.linkBlacklist, s.dismissedLinks);
    await linksStore.set(charId, found.length ? found : null);
    if (s.assetLinksTag) {
      if (found.length) await ciApi.bulkTags([charId], { add: [s.assetLinksTag] });
    }
    return found.length;
  }

  /** Drops stored links now dismissed or blacklisted; untags characters left with none. */
  async function pruneAssetLinks() {
    const s = ciSettings.get();
    const all = await linksStore.all();
    const untag = [];
    for (const [id, found] of Object.entries(all)) {
      const kept = found.filter(({ url }) => !ciCore.isLinkIgnored(url, s.linkBlacklist, s.dismissedLinks));
      if (kept.length === found.length) continue;
      await linksStore.set(id, kept.length ? kept : null);
      if (!kept.length) untag.push(id);
    }
    if (untag.length && s.assetLinksTag) await ciApi.bulkTags(untag, { remove: [s.assetLinksTag] }).catch(() => undefined);
    return untag.length;
  }

  // ── Running the steps ──

  async function tag(charId, name) {
    name = String(name ?? "").trim();
    if (name) await ciApi.bulkTags([charId], { add: [name] });
  }

  /**
   * Every asset step for one character. Each step fails on its own: a failed
   * step is reported in `warnings`, the rest still run.
   * @param {{expressions?: boolean, localize?: boolean, lorebooks?: boolean, links?: boolean, freshChub?: boolean,
   *   signal?: AbortSignal, onStep?: (text: string) => void}} options
   * @returns {Promise<{warnings: string[], summary: string[], data: object}>}
   */
  async function importAssets(charId, data, options = {}) {
    const { signal, onStep } = options;
    const warnings = [];
    const summary = [];
    const isChub = !!data.extensions?.chub || (data.extensions?.char_importer?.source_key ?? "").startsWith("chub:");
    const checked = {};

    const step = async (name, label, fn) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          onStep?.(label);
          await fn();
          checked[name] = Date.now();
          return;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ciNet.RateLimitError && attempt === 0) {
            onStep?.(`${label} (rate limited, waiting ${Math.round(error.retryAfterMs / 1000)}s)`);
            await ciNet.sleep(error.retryAfterMs, signal);
            continue;
          }
          marinara.log.warn(`${label} failed`, error);
          warnings.push(`${label}: ${ciNet.describe(error)}`);
          return;
        }
      }
    };

    if (options.links !== false) {
      await step("links", "Asset links", async () => {
        const n = await flagAssetLinks(charId, data);
        if (n) summary.push(`${n} asset link${n === 1 ? "" : "s"}`);
      });
    }

    let chub = data.extensions?.chub;
    if (isChub && options.freshChub && (options.expressions || options.lorebooks) && chub?.full_path) {
      try {
        const node = await ciSources.fetchChubDetail(chub.full_path, signal);
        chub = node?.definition?.extensions?.chub ?? chub;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }

    if (isChub && options.expressions) {
      await step("expressions", "Expressions", async () => {
        const n = await importExpressions(charId, chub, { signal, onProgress: (d, t) => onStep?.(`Expressions ${d} / ${t}`) });
        if (n) {
          summary.push(`${n} sprite${n === 1 ? "" : "s"}`);
          await tag(charId, ciSettings.get().expressionsTag);
        }
      });
    }
    if (isChub && options.localize) {
      await step("gallery", "Gallery", async () => {
        const result = await importChubGallery(charId, data, { signal, onProgress: (d, t) => onStep?.(`Gallery ${d} / ${t}`) });
        data = result.data;
        if (result.added) summary.push(`${result.added} gallery image${result.added === 1 ? "" : "s"}`);
      });
    }
    if (isChub && options.lorebooks) {
      await step("lorebooks", "Lorebooks", async () => {
        const n = await importChubLorebooks(charId, { ...data, extensions: { ...data.extensions, chub } }, { signal, onProgress: (d, t) => onStep?.(`Lorebooks ${d} / ${t}`) });
        if (n) summary.push(`${n} lorebook${n === 1 ? "" : "s"}`);
      });
    }
    if (options.localize) {
      await step("images", "Card images", async () => {
        const result = await localizeImages(charId, data, { signal, onProgress: (d, t, note) => onStep?.(`Card images ${d} / ${t}${note ? ` (${note})` : ""}`) });
        data = result.data;
        if (result.saved) summary.push(`${result.saved} card image${result.saved === 1 ? "" : "s"}`);
        if (result.failed) warnings.push(`${result.failed} card image${result.failed === 1 ? "" : "s"} could not be saved`);
      });
    }
    if (Object.keys(checked).length) await checkedStore.patch(charId, checked);
    return { warnings, summary, data };
  }

  // ── Library jobs ──

  let job = null; // {kind, stop, controller}
  const currentJob = () => job;

  function startJob(kind) {
    if (job) throw new Error(`${job.kind} is already running`);
    job = { kind, stop: false, controller: new AbortController() };
    return job;
  }
  function stopJob() {
    if (!job) return;
    job.stop = true;
    job.controller.abort();
  }

  /**
   * Fetch assets for every character that hasn't had them yet.
   * @param {{onStatus: (text: string) => void}} options
   */
  async function backfill({ onStatus }) {
    const run = startJob("Fetch assets");
    try {
      const s = ciSettings.get();
      const parts = s.backfillParts;
      await ciLib.refresh({ onProgress: onStatus });
      const index = ciLib.get();
      const checked = await checkedStore.all();
      const todo = [];
      for (const [id, entry] of Object.entries(index)) {
        const c = checked[id] ?? {};
        const isChub = entry.keys?.some((k) => k.startsWith("chub:"));
        const want = {
          links: parts.links && !c.links,
          expressions: parts.expressions && isChub && !c.expressions && (entry.hasChubPack || s.checkAddedPacks),
          gallery: parts.gallery && isChub && !!entry.chubId && !c.gallery,
          lorebooks: parts.lorebooks && isChub && !c.lorebooks,
          images: parts.images && !c.images,
        };
        if (Object.values(want).some(Boolean)) todo.push({ id, name: entry.name, want });
      }
      let n = 0;
      let warned = 0;
      for (const item of todo) {
        if (run.stop) break;
        n++;
        const prefix = `Fetch assets ${n} / ${todo.length}: ${item.name}`;
        onStatus(prefix);
        let row;
        try {
          row = await ciApi.getCharacter(item.id);
        } catch {
          continue;
        }
        if (!row) continue;
        const w = item.want;
        // Lorebooks and gallery are Chub-only and part of "localize" / "lorebooks"
        const result = await importAssets(item.id, row.data, {
          links: w.links,
          expressions: w.expressions,
          localize: w.gallery || w.images,
          lorebooks: w.lorebooks,
          freshChub: true,
          signal: run.controller.signal,
          onStep: (text) => onStatus(`${prefix} - ${text}`),
        }).catch((error) => {
          if (run.stop) return null;
          throw error;
        });
        if (!result) break;
        if (result.warnings.length) warned++;
        await ciNet.sleep(1000, run.controller.signal).catch(() => undefined);
      }
      ciApi.refreshMarinara(["characters", "sprites", "lorebooks", "gallery"]);
      return { done: n, total: todo.length, warned, stopped: run.stop };
    } finally {
      job = null;
    }
  }

  /** Characters with image downloads that failed: [{id, count}]. */
  async function failureSummary() {
    const all = await failuresStore.all();
    const index = await ciLib.load();
    const list = Object.entries(all)
      .filter(([id]) => index[id])
      .map(([id, urls]) => ({ id, name: index[id].name, urls }));
    return { cards: list.length, images: list.reduce((sum, item) => sum + Object.keys(item.urls).length, 0), list };
  }

  /** Try failed card images again. */
  async function retryFailed({ onStatus }) {
    const run = startJob("Retry failed images");
    try {
      const { list } = await failureSummary();
      let n = 0;
      let recovered = 0;
      for (const item of list) {
        if (run.stop) break;
        n++;
        const urls = Object.keys(item.urls);
        if (urls.every((url) => ciNet.isHostDown(url))) continue;
        onStatus(`Retry ${n} / ${list.length}: ${item.name}`);
        const row = await ciApi.getCharacter(item.id).catch(() => null);
        if (!row) {
          await failuresStore.set(item.id, null);
          continue;
        }
        try {
          const result = await localizeImages(item.id, row.data, { signal: run.controller.signal });
          recovered += result.saved;
        } catch (error) {
          if (run.stop) break;
          if (error instanceof ciNet.RateLimitError) {
            onStatus(`Rate limited, waiting ${Math.round(error.retryAfterMs / 1000)}s`);
            await ciNet.sleep(error.retryAfterMs, run.controller.signal).catch(() => undefined);
          } else if (error instanceof ciNet.LocalSaveError) {
            throw error;
          }
        }
      }
      ciApi.refreshMarinara(["characters", "gallery"]);
      return { done: n, total: list.length, recovered, stopped: run.stop };
    } finally {
      job = null;
    }
  }

  /** Read every card and record the ones still linking web images (downloads nothing). */
  async function scanUnsaved({ onStatus }) {
    const run = startJob("Find unsaved images");
    try {
      await ciLib.refresh({ onProgress: onStatus });
      let n = 0;
      let found = 0;
      const ids = Object.keys(ciLib.get());
      for await (const rows of ciApi.iterateCharacters()) {
        if (run.stop) break;
        for (const row of rows) {
          n++;
          const urls = pendingImages(row.data);
          const prev = (await failuresStore.get(row.id)) ?? {};
          if (!urls.length) {
            if (Object.keys(prev).length) await failuresStore.set(row.id, null);
            continue;
          }
          found++;
          const next = {};
          for (const url of urls) next[url] = prev[url] ?? { t: Date.now(), reason: "Not saved yet" };
          await failuresStore.set(row.id, next);
        }
        onStatus(`Scanning ${n} / ${ids.length}... ${found} with web images`);
      }
      return { scanned: n, found, stopped: run.stop };
    } finally {
      job = null;
    }
  }

  /** Forget everything stored for deleted characters. */
  async function forget(ids) {
    for (const store of [failuresStore, linksStore, checkedStore, packsStore, hashStore]) await store.remove(ids);
  }

  return Object.freeze({
    TEXT_FIELDS, cardImageUrls, rewriteImageUrls, selfRef, charRef, fileOf,
    galleryState, saveImages, fetchImageBytes, cleanupTempGallery, ensureFolder,
    importExpressions, importChubGallery, importChubLorebooks, importLorebookLink, localizeImages, flagAssetLinks, pruneAssetLinks,
    importAssets, currentJob, stopJob, backfill, failureSummary, retryFailed, scanUnsaved, forget,
    failuresStore, linksStore, checkedStore, packsStore, hashStore,
  });
})();
