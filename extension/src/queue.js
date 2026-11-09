// Char Importer: the import queue. Links run one at a time in the order
// added; each keeps the options of the dialog it came from. The queue is
// saved after every step, so a reload can pick up where it stopped: a
// character that was saved before the reload only gets its assets finished.

const ciQueue = (() => {
  "use strict";

  /** @typedef {{url: string, opts: object, state: "pending"|"running"|"done"|"warn"|"skipped"|"failed", note: string, interrupted?: boolean, charId?: string, name?: string}} QueueItem */
  // shutdown: "Turn off Marinara when done" for this session only (never saved).
  // shutdownAt: when the countdown ends; shutdownSent: the request went to the watcher script
  // watcher: the shutdown watcher script's heartbeat is fresh (it's listening)
  const queue = { items: [], running: false, stop: false, paused: false, step: "", shutdown: false, shutdownAt: 0, shutdownSent: false, watcher: false };
  // The watcher beats every 30 s; allow for a missed one
  const WATCHER_FRESH_MS = 75_000;
  const SHUTDOWN_GRACE_MS = 30_000;
  let shutdownTimer = 0;
  let stoppedByUser = false;
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
    const items = queue.items.map(({ url, opts, state, note, interrupted, charId, name, recheck }) => ({ url, opts, state, note, interrupted, charId, name, recheck }));
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
   * `recheck` downloads them even if they're in the library, and compares.
   * @returns {{added: number, alreadyQueued: number, joined: boolean}}
   */
  function add(links, opts, { recheck = false } = {}) {
    const active = new Set(queue.items.filter((i) => i.state === "pending" || i.state === "running").map((i) => i.url));
    let added = 0;
    for (const url of links) {
      if (active.has(url)) continue;
      active.add(url);
      queue.items.push({ url, opts: { ...opts }, state: "pending", note: "", ...(recheck ? { recheck: true } : {}) });
      added++;
    }
    const joined = queue.running;
    void save();
    notify();
    if (!queue.running && added) void run();
    return { added, alreadyQueued: links.length - added, joined };
  }

  /** Reads the shutdown watcher's heartbeat from this extension's storage. */
  async function checkWatcher() {
    try {
      const at = Number((await marinara.storage.get())?.shutdownWatcher?.at) || 0;
      const alive = Date.now() - at < WATCHER_FRESH_MS;
      if (alive !== queue.watcher) {
        queue.watcher = alive;
        notify();
      }
    } catch (error) {
      marinara.log.warn("Could not check for the shutdown watcher", error);
    }
    return queue.watcher;
  }

  /** Arms or disarms "Turn off Marinara when done". */
  function setShutdown(on) {
    queue.shutdown = !!on;
    if (!on) cancelShutdown();
    notify();
  }

  function cancelShutdown() {
    clearTimeout(shutdownTimer);
    shutdownTimer = 0;
    queue.shutdownAt = 0;
    notify();
  }

  // After the queue finishes on its own: a grace period to cancel, then the request the
  // watcher script (tools/shutdown-watcher.mjs) polls for in this extension's storage
  function startShutdownCountdown() {
    queue.shutdownAt = Date.now() + SHUTDOWN_GRACE_MS;
    queue.shutdownSent = false;
    notify();
    shutdownTimer = setTimeout(async () => {
      shutdownTimer = 0;
      queue.shutdownAt = 0;
      try {
        await ciSettings.flush();
        await marinara.storage.patch({ shutdownRequest: { at: Date.now() } });
        queue.shutdownSent = true;
        queue.shutdown = false;
        const alive = await checkWatcher();
        ciDom.toast(alive ? "Asked the shutdown watcher to turn Marinara off." : "Asked to turn Marinara off, but no shutdown watcher has been seen lately, so it may stay on.", alive ? "info" : "warn");
      } catch (error) {
        marinara.log.error("Could not send the shutdown request", error);
        ciDom.toast(`Couldn't ask to turn Marinara off: ${ciNet.describe(error)}`, "error");
      }
      notify();
    }, SHUTDOWN_GRACE_MS);
  }

  function stopAfterCurrent() {
    if (queue.running) {
      queue.stop = true;
      stoppedByUser = true;
    }
    notify();
  }

  /** Stop now: aborts the current download. */
  function abort() {
    queue.stop = true;
    stoppedByUser = true;
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

  /** Name of the library character that keeps `key` as an obsolete (merged-away) version, if any. */
  function obsoleteOwner(key) {
    const entry = Object.values(ciLib.get()).find((e) => e.obsolete?.includes(key));
    return entry ? entry.name || "a character" : null;
  }

  /** The library copy that answers to `key` and has this content hash: {id, name}. */
  function sameCopy(key, hash) {
    const found = Object.entries(ciLib.get()).find(([, e]) => e.hash === hash && e.keys?.includes(key));
    return found ? { id: found[0], name: found[1].name || "a character" } : null;
  }

  /**
   * Records another link on a library character (char_importer.also_keys),
   * so the duplicate checks, profile imports and the owned lists know the
   * card from there too. Returns whether it was saved.
   */
  async function linkKey(charId, key, existing) {
    try {
      const row = await ciApi.getCharacter(charId);
      if (!row) return false;
      const marker = row.data?.extensions?.char_importer ?? {};
      const also = Array.isArray(marker.also_keys) ? marker.also_keys : [];
      if (also.includes(key) || marker.source_key === key) return true;
      const pinned = {
        ...marker,
        // Pinned, so what it matches doesn't change with later edits
        content_hash: ciCore.savedHash(row.data) || ciCore.contentHash(row.data, { ignoreSaved: true }) || undefined,
        also_keys: [...also, key],
      };
      const updated = await ciApi.updateCharacter(charId, { extensions: { char_importer: pinned } }, { skipVersionSnapshot: true });
      await ciLib.put(updated ?? (await ciApi.getCharacter(charId)));
      existing.keys.set(key, charId);
      ciLib.publishOwnedSoon();
      return true;
    } catch (error) {
      marinara.log.warn(`Could not record ${key} on character ${charId}`, error);
      return false;
    }
  }

  /** Whether Botbooru has the card as downloaded by you; null when it can't be asked (says why once). */
  async function botbooruKnows(id, signal, setStep) {
    setStep("Asking Botbooru");
    try {
      return await ciSources.botbooruKnows(id, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ciSources.BotbooruAccessError) ciAssets.botbooruNotice(error.reason);
      else marinara.log.warn(`Couldn't ask Botbooru about ${id}`, error);
      return null;
    }
  }

  const SOURCE_NAMES = { chub: "Chub", botbooru: "Botbooru", uuid: "JanitorAI/Pygmalion", risu: "RisuRealm", wyvern: "Wyvern", datacat: "DataCat", aicc: "AICharacterCards" };
  const sourceName = (key) => SOURCE_NAMES[key.split(":", 1)[0]] ?? "another link";

  /**
   * A creator's profile: lists their cards and queues them right after it,
   * leaving out cards already in the library or already queued.
   */
  async function expandProfile(item, plan, existing, signal, setStep) {
    setStep("Listing cards");
    let listed;
    try {
      listed = await ciSources.listBotbooruProfile(plan.id, { signal, onProgress: (n, total) => setStep(`Listing cards ${n} / ${total}`) });
    } catch (error) {
      if (error instanceof ciSources.BotbooruAccessError) ciAssets.botbooruNotice(error.reason, "profile");
      throw error;
    }
    const queued = new Set(queue.items.filter((i) => i.state === "pending" || i.state === "running").map((i) => i.url));
    const fresh = [];
    let owned = 0;
    let already = 0;
    let updated = 0;
    let unmarked = 0;
    let blocked = 0;
    // Only profile imports: a card pasted on its own is imported whatever its tags
    const blacklist = new Set(ciSettings.get().profileTagBlacklist.map(ciCore.normTag).filter(Boolean));
    for (const { link: url, state, tags } of listed.cards) {
      if (blacklist.size && tags?.some((t) => blacklist.has(t))) {
        blocked++;
        continue;
      }
      // Cards you have: skipped if Botbooru has them as downloaded and unchanged, otherwise checked
      // (changed since, or imported without your login so Botbooru doesn't know)
      const cardKey = ciCore.normalizeSource(url);
      const have = item.opts.preventDuplicates && existing.keys.has(cardKey);
      // Merged away as obsolete: never queued again, even when Botbooru says it changed
      if (have && (state === "current" || obsoleteOwner(cardKey))) owned++;
      else if (queued.has(url)) already++;
      else {
        if (have && state === "updated") updated++;
        else if (have) unmarked++;
        queued.add(url);
        fresh.push({ url, opts: { ...item.opts }, state: "pending", note: "", ...(have ? { recheck: true } : {}) });
      }
    }
    queue.items.splice(queue.items.indexOf(item) + 1, 0, ...fresh);
    const total = listed.cards.length;
    const parts = [
      updated && `${updated} updated since you got ${updated === 1 ? "it" : "them"}`,
      unmarked && `${unmarked} you have to compare`,
      owned && `${owned} already in the library`,
      blocked && `${blocked} left out by tag`,
      already && `${already} already queued`,
    ].filter(Boolean);
    item.name = listed.name;
    item.state = fresh.length ? "done" : "skipped";
    item.note = `${listed.name}: queued ${fresh.length} of ${total} card${total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
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

    if (plan.kind === "list") {
      await expandProfile(item, plan, existing, signal, setStep);
      return null;
    }

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

    // recheck: download it anyway and compare with the library copy (a Botbooru card that may have
    // changed, or that Botbooru doesn't know you have because it was imported without your login)
    let recheck = !!item.recheck;
    // A link merged away as an obsolete version is never imported or rechecked again
    const obsolete = opts.preventDuplicates ? obsoleteOwner(key) : null;
    if (obsolete) {
      finish("skipped", `Obsolete copy of ${obsolete}`);
      return "link";
    }
    if (opts.preventDuplicates && existing.keys.has(key) && !recheck) {
      const known = plan.provider === "botbooru" ? await botbooruKnows(plan.id, signal, setStep) : null;
      if (known !== false) {
        finish("skipped", `Duplicate link (${lookup(existing.keys, key)})${known ? "; Botbooru has it as downloaded" : ""}`);
        return "link";
      }
      recheck = true;
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
    const post = loaded.botbooruPost;
    const marked = plan.provider !== "botbooru" ? ""
      : loaded.botbooruRecorded ? "; marked as downloaded on Botbooru" : "; not marked on Botbooru (no login)";

    // A Botbooru fork of a card you have: unchanged ones are irrelevant (skipped, linked to it)
    let forkNote = null;
    const parentId = String(post?.fork_of_post_id ?? "");
    if (opts.preventDuplicates && /^\d+$/.test(parentId) && existing.keys.has(`botbooru:${parentId}`)) {
      const parentKey = `botbooru:${parentId}`;
      const copy = hash ? sameCopy(parentKey, hash) : null;
      if (copy) {
        const linked = (await linkKey(copy.id, key, existing)) ? "; link added to it" : "";
        finish("skipped", `Unchanged fork of ${copy.name}${linked}${marked}`);
        return "content";
      }
      forkNote = `fork of ${lookup(existing.keys, parentKey)}, with changes`;
    }

    // The card can name other sources too, e.g. a Botbooru re-upload of a Chub card. Only an
    // identical copy is skipped: creators who moved sites often updated the card on the new one.
    // A rechecked card is compared with its own link's copies too.
    let olderCopy = null;
    if (opts.preventDuplicates) {
      const keys = [...new Set([...(recheck ? [key] : []), ...ciCore.keysFromCard(loaded.card)])];
      const others = keys.filter((k) => (k !== key || recheck) && existing.keys.has(k));
      const same = hash ? others.map((k) => [k, sameCopy(k, hash)]).find(([, copy]) => copy) : null;
      if (same) {
        const [k, copy] = same;
        // A copy from another source learns this link, so it isn't downloaded again next time
        const linked = k !== key && (await linkKey(copy.id, key, existing)) ? "; link added to it" : "";
        finish("skipped", `${k === key ? "Duplicate link, same as your copy" : `Same card already in the library from ${sourceName(k)}`} (${copy.name})${linked}${marked}`);
        return k === key ? "link" : "content";
      }
      if (others.length) olderCopy = `${lookup(existing.keys, others[0])} from ${sourceName(others[0])}`;
    }

    if (opts.preventDuplicates && opts.contentCheck && hash && existing.hashes.has(hash)) {
      // Linked like the other identical copies, so this link is known (and hidden) from now on
      const linked = (await linkKey(existing.hashes.get(hash), key, existing)) ? "; link added to it" : "";
      finish("skipped", `Identical card already in the library (${lookup(existing.hashes, hash)})${linked}${marked}`);
      return "content";
    }

    // A repost account's card that differs from yours and shares no link: matched by name and
    // creator and linked as a duplicate (still imported: it may keep images the original lost)
    const alsoKeys = [];
    let repostNote = null;
    const uploader = String(post?.uploader_name ?? "").toLowerCase() || ciCore.botbooruUploader(loaded.card);
    if (plan.provider === "botbooru" && !olderCopy && ciSettings.isRepost(uploader)) {
      const data = ciCore.cardData(loaded.card);
      const name = ciCore.normName(data.name);
      const creator = ciCore.normName(data.creator);
      const match = name && creator ? Object.values(ciLib.get()).find((e) => e.creator === creator && ciCore.normName(e.name) === name) : null;
      if (match?.keys?.length) {
        alsoKeys.push(match.keys[0]);
        repostNote = `repost by ${uploader}, linked to ${match.name || "a character"} as a duplicate; see Flag duplicates`;
      } else if (match) {
        repostNote = `repost by ${uploader}, same name and creator as ${match.name || "a character"}`;
      }
    }

    setStep("Importing");
    const marker = {
      v: 1, source_key: key, source_url: url, content_hash: hash || undefined, imported_at: new Date().toISOString(),
      ...(alsoKeys.length ? { also_keys: alsoKeys } : {}),
    };
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
    ciLib.publishOwnedSoon(); // so Chub hides it without waiting for the whole queue
    for (const k of entry.keys) if (!existing.keys.has(k)) existing.keys.set(k, row.id);
    ciApi.refreshMarinara(["characters", "lorebooks"]);

    const assets = await ciAssets.importAssets(row.id, row.data, { ...assetOptions(opts), signal, onStep: setStep, botbooruPost: post });
    ciApi.refreshMarinara(["characters", "sprites", "gallery", "lorebooks"]);
    const name = result.name || row.data.name;
    if (merged) {
      ciTags.add(merged.tags);
      if (merged.merged) assets.summary.push(`${merged.merged} tag${merged.merged === 1 ? "" : "s"} merged to canonicals`);
    }
    assets.warnings.push(...tagNotes);
    // Flag duplicates groups the two (they share the source link) to compare or merge
    if (forkNote) assets.summary.push(forkNote);
    if (olderCopy) assets.summary.push(`differs from ${olderCopy}, maybe an update; see Flag duplicates`);
    if (repostNote) assets.summary.push(repostNote);
    const extra = assets.summary.length ? ` (${assets.summary.join(", ")})` : "";
    if (assets.warnings.length) finish("warn", `Imported ${name}${extra}; ${assets.warnings.join("; ")}`);
    else finish("done", `Imported ${name}${extra}`);
    return null;
  }

  async function run() {
    if (queue.running) return;
    cancelShutdown();
    stoppedByUser = false;
    queue.shutdownSent = false;
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
    // Left to finish on its own: turn Marinara off if asked (not when you stopped it yourself)
    if (queue.shutdown && !stoppedByUser && !disposed) {
      await ciLib.publishOwned();
      startShutdownCountdown();
    }
    const parts = [];
    if (skippedLinks.length) parts.push(`${skippedLinks.length} duplicate link${skippedLinks.length === 1 ? "" : "s"}`);
    if (skippedContent.length) parts.push(`${skippedContent.length} identical card${skippedContent.length === 1 ? "" : "s"}`);
    if (parts.length) ciDom.toast(`Skipped ${parts.join(" and ")}.`, "info");
  }

  function dispose() {
    disposed = true;
    clearTimeout(shutdownTimer);
    queue.stop = true;
    controller?.abort();
    listeners.clear();
  }

  return Object.freeze({ dispose, subscribe, restore, add, stopAfterCurrent, abort, resume, dismiss, clearFinished, isRunning, get, setShutdown, cancelShutdown, checkWatcher });
})();
