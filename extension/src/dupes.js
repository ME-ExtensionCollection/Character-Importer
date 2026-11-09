// Char Importer: Flag duplicates. Copies that share a source link or content
// hash are grouped. Identical copies are merged into one keeper (gallery,
// sprites, tags, favorite, lorebook links), each removed copy is backed up
// (Marinara native export, kept in this browser) and deleted. Copies with
// chats or in groups are never deleted. Groups whose copies differ in content
// are only tagged.

const ciDupes = (() => {
  "use strict";

  const MERGED_FOLDER = "Merged";

  // ── Blockers ──

  function parseIds(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /** Map of character id -> why it must stay (a chat or a group uses it). */
  async function loadBlockers() {
    const [chats, groups] = await Promise.all([ciApi.listChats(), ciApi.listGroups()]);
    const why = new Map();
    const add = (id, reason) => {
      if (id && !why.has(id)) why.set(id, reason);
    };
    for (const chat of Array.isArray(chats) ? chats : []) {
      const name = chat.name ? `chat "${chat.name}"` : "a chat";
      for (const id of parseIds(chat.characterIds)) add(id, `used in ${name}`);
      add(chat.personaCharacterId, `persona in ${name}`);
      const meta = chat.metadata ?? {};
      for (const id of parseIds(meta.gamePartyCharacterIds)) add(id, `party member in ${name}`);
      for (const id of parseIds(meta.gameSetupConfig?.partyCharacterIds)) add(id, `party member in ${name}`);
    }
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const id of parseIds(group.characterIds)) add(id, `member of group "${group.name ?? "?"}"`);
    }
    return why;
  }

  /**
   * @returns {Promise<{sets: {keeper: object, remove: object[], kept: object[]}[], differing: object[][], similar: object[]}>}
   *   copies are {id, name, created, blocker}
   */
  async function find(onStatus) {
    onStatus?.("Scanning the library...");
    await ciLib.refresh({ onProgress: onStatus });
    const index = ciLib.get();
    const entries = Object.entries(index).map(([id, e]) => ({ id, name: e.name, keys: e.keys, hash: e.hash, created: e.created, uploader: e.uploader }));
    onStatus?.("Looking for duplicates...");
    const { identical, differing } = ciCore.findDuplicateSets(entries);
    onStatus?.("Checking chats and groups...");
    const blockers = await loadBlockers();
    const toCopy = (e) => ({ id: e.id, name: e.name, created: e.created, blocker: blockers.get(e.id) ?? null, repost: ciSettings.isRepost(e.uploader) });
    const sets = identical.map((group) => {
      const copies = group.map(toCopy);
      // Copies in chats or groups stay; otherwise the author's copy rather than a repost account's
      const keeper = copies.find((c) => c.blocker) ?? copies.find((c) => !c.repost) ?? copies[0];
      const others = copies.filter((c) => c !== keeper);
      return { keeper, remove: others.filter((c) => !c.blocker), kept: others.filter((c) => c.blocker) };
    });
    let similar = [];
    try {
      // Marinara's own name/description similarity finder, shown for information
      const known = new Set(identical.flat().map((e) => e.id));
      similar = ((await ciApi.duplicates())?.groups ?? []).filter((g) => (g.ids ?? []).some((id) => !known.has(id)));
    } catch (error) {
      marinara.log.warn("Marinara's duplicate finder failed", error);
    }
    return { sets, differing: differing.map((g) => g.map(toCopy)), similar };
  }

  // ── Merging ──

  /** Copies gallery images the keeper lacks. @returns {Promise<Record<string,string>>} old file -> keeper file */
  async function mergeGallery(fromId, toId) {
    const renamed = {};
    const rows = await ciApi.listGallery(fromId);
    if (!rows.length) return renamed;
    const state = await ciAssets.galleryState(toId);
    for (const row of rows) {
      const file = ciAssets.fileOf(row);
      const { bytes } = await ciApi.readBytes(row.url);
      const hash = await ciPng.sha1Hex(bytes);
      const existing = state.byHash.get(hash);
      if (existing) {
        renamed[file] = existing;
        continue;
      }
      const mime = ciPng.sniffImageType(bytes);
      const ext = ciPng.extensionFor(mime);
      if (!ext) continue; // videos and other files stay with the backup
      const created = await ciApi.uploadGallery(toId, bytes, `image.${ext}`, mime);
      const newFile = ciAssets.fileOf(created);
      // Read back to be sure it arrived intact
      const check = await ciPng.sha1Hex((await ciApi.readBytes(created.url)).bytes);
      if (check !== hash) throw new ciNet.LocalSaveError(`Gallery image ${file} did not copy correctly`);
      state.byHash.set(hash, newFile);
      state.hashes[newFile] = hash;
      renamed[file] = newFile;
    }
    await ciAssets.hashStore.set(toId, state.hashes);
    return renamed;
  }

  /** Copies sprites the keeper lacks. Into the same folders if the keeper has none, else under "Merged". */
  async function mergeSprites(fromId, toId) {
    const theirs = await ciApi.listSprites(fromId);
    if (!theirs.length) return 0;
    const mine = await ciApi.listSprites(toId);
    const hashes = new Set();
    for (const sprite of mine) {
      try {
        hashes.add(await ciPng.sha1Hex((await ciApi.readBytes(sprite.url)).bytes));
      } catch {
        // ignore
      }
    }
    const keeperEmpty = mine.length === 0;
    const folderIds = new Map();
    const folderFor = async (name) => {
      const target = keeperEmpty ? name : name ? `${MERGED_FOLDER} - ${name}` : MERGED_FOLDER;
      if (!target) return null;
      if (!folderIds.has(target)) folderIds.set(target, await ciAssets.ensureFolder(toId, target.slice(0, 100)));
      return folderIds.get(target);
    };
    let copied = 0;
    for (const sprite of theirs) {
      if (String(sprite.expression ?? "").startsWith("full_")) continue; // full-body sprites need a full-body folder; left in the backup
      const { bytes } = await ciApi.readBytes(sprite.url);
      const hash = await ciPng.sha1Hex(bytes);
      if (hashes.has(hash)) continue;
      const mime = ciPng.sniffImageType(bytes);
      if (!mime) continue;
      const folderId = await folderFor(sprite.folderName ?? null);
      const result = await ciApi.uploadSprite(toId, { expression: sprite.label ?? sprite.expression, image: ciPng.toDataUrl(bytes, mime), folderId });
      if (result) {
        hashes.add(hash);
        copied++;
      }
    }
    return copied;
  }

  /** Tags, favorite, lorebook links and our URL maps, onto the keeper. */
  async function mergeCard(from, to, renamed) {
    const fromData = from.data ?? {};
    const toData = to.data ?? {};
    const tags = Array.isArray(fromData.tags) ? fromData.tags.filter((t) => typeof t === "string") : [];
    if (tags.length) await ciApi.bulkTags([to.id], { add: tags });

    const extensions = {};
    if (fromData.extensions?.fav === true && toData.extensions?.fav !== true) extensions.fav = true;
    const mapFiles = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([, f]) => renamed[f]).map(([url, f]) => [url, renamed[f]]));
    const fromMarker = fromData.extensions?.char_importer ?? {};
    const toMarker = toData.extensions?.char_importer ?? {};
    const gallery = { ...mapFiles(fromMarker.gallery), ...(toMarker.gallery ?? {}) };
    const images = { ...mapFiles(fromMarker.images), ...(toMarker.images ?? {}) };
    if (Object.keys(gallery).length || Object.keys(images).length) {
      extensions.char_importer = {
        ...toMarker,
        content_hash: ciCore.savedHash(toData) || ciCore.contentHash(toData, { ignoreSaved: true }),
        ...(Object.keys(gallery).length ? { gallery } : {}),
        ...(Object.keys(images).length ? { images } : {}),
      };
    }
    if (Object.keys(extensions).length) await ciApi.updateCharacter(to.id, { extensions }, { skipVersionSnapshot: true });

    // Before the copy is deleted: a lorebook left without characters gets disabled
    const books = await ciApi.lorebooksForCharacter(from.id);
    for (const book of Array.isArray(books) ? books : []) await ciApi.linkLorebook(book.id, to.id);
  }

  // ── Backups ──

  async function backup(id, name) {
    const json = await ciApi.exportCharacter(id);
    JSON.parse(json); // must be a complete export before anything is deleted
    const key = `${Date.now()}-${id}`;
    await ciIdb.set(key, { key, id, name, at: Date.now(), json }, "backups");
    return key;
  }

  async function listBackups() {
    const keys = await ciIdb.keys("backups");
    const out = [];
    for (const key of keys) {
      const item = await ciIdb.get(key, "backups");
      if (item) out.push({ key, id: item.id, name: item.name, at: item.at, size: item.json.length });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async function restoreBackup(key) {
    const item = await ciIdb.get(key, "backups");
    if (!item) throw new Error("Backup not found");
    const result = await ciApi.importMarinara(JSON.parse(item.json));
    ciApi.refreshMarinara(["characters", "gallery", "sprites"]);
    return result;
  }

  async function backupBlob(key) {
    const item = await ciIdb.get(key, "backups");
    if (!item) throw new Error("Backup not found");
    return { blob: new Blob([item.json], { type: "application/json" }), filename: `${ciCore.safeName(item.name, "character")}.marinara.json` };
  }

  const deleteBackup = (key) => ciIdb.del(key, "backups");

  /**
   * Records a merged-away copy's links on the keeper as obsolete versions:
   * still owned (hidden on Chub/Botbooru), never imported or rechecked again.
   * Links the keeper itself answers to are left alone.
   */
  async function markObsolete(from, toId) {
    const to = await ciApi.getCharacter(toId);
    if (!to) return;
    const own = new Set(ciCore.keysFromCard(to.data));
    const marker = to.data?.extensions?.char_importer ?? {};
    const before = Array.isArray(marker.obsolete_keys) ? marker.obsolete_keys : [];
    const added = ciCore.keysFromCard(from.data).filter((k) => !own.has(k) && !before.includes(k) && !k.startsWith("chublore:"));
    if (!added.length) return;
    const pinned = {
      ...marker,
      content_hash: ciCore.savedHash(to.data) || ciCore.contentHash(to.data, { ignoreSaved: true }) || undefined,
      obsolete_keys: [...before, ...added],
    };
    await ciApi.updateCharacter(toId, { extensions: { char_importer: pinned } }, { skipVersionSnapshot: true });
  }

  // ── Cleanup ──

  /**
   * @param {{keeper: object, remove: object[]}[]} sets from find(), after the user unticked what to keep
   * @param {{deleteCopies?: boolean, tagDiffering?: object[][], obsoleteSets?: {keeper: object, remove: object[]}[]}} options
   *   obsoleteSets: groups whose copies differ, merged into the chosen keeper; the removed copies' links become obsolete
   * @returns {Promise<{deleted: number, merged: number, tagged: number, problems: string[]}>}
   */
  async function cleanup(sets, { deleteCopies = true, tagDiffering = [], obsoleteSets = [], onStatus } = {}) {
    if (ciAssets.currentJob() || ciQueue.isRunning()) throw new Error("Wait for the import queue and asset jobs to finish first");
    const problems = [];
    let deleted = 0;
    let merged = 0;
    const deletedIds = [];
    let blockers = await loadBlockers();
    let n = 0;
    const all = [...sets.map((set) => ({ set, obsolete: false })), ...obsoleteSets.map((set) => ({ set, obsolete: true }))];
    const total = all.reduce((sum, { set }) => sum + set.remove.length, 0);

    for (const { set, obsolete } of all) {
      for (const copy of set.remove) {
        n++;
        onStatus?.(`Merging ${n} / ${total}: ${copy.name}`);
        try {
          const [from, to] = await Promise.all([ciApi.getCharacter(copy.id), ciApi.getCharacter(set.keeper.id)]);
          if (!from || !to) {
            problems.push(`${copy.name}: no longer in the library`);
            continue;
          }
          const renamed = await mergeGallery(from.id, to.id);
          await mergeSprites(from.id, to.id);
          await mergeCard(from, to, renamed);
          if (obsolete) await markObsolete(from, to.id);
          merged++;
          // A differing copy is always removed once merged: its links now point at the keeper
          if (!deleteCopies && !obsolete) continue;
          await backup(from.id, copy.name);
          // Chats may have started since the scan
          blockers = await loadBlockers();
          if (blockers.has(from.id)) {
            problems.push(`${copy.name}: kept, ${blockers.get(from.id)}`);
            continue;
          }
          const sprites = await ciApi.listSprites(from.id).catch(() => []);
          await ciApi.deleteCharacter(from.id);
          for (const sprite of sprites) await ciApi.deleteSprite(from.id, sprite.expression).catch(() => undefined);
          deleted++;
          deletedIds.push(from.id);
        } catch (error) {
          marinara.log.error(`Duplicate cleanup failed for ${copy.name}`, error);
          problems.push(`${copy.name}: ${ciNet.describe(error)}`);
        }
      }
    }
    for (const id of deletedIds) await ciLib.remove(id);
    await ciAssets.forget(deletedIds);

    let tagged = 0;
    const tag = ciSettings.get().duplicateTag;
    if (tag && tagDiffering.length) {
      const gone = new Set(deletedIds);
      const ids = [...new Set(tagDiffering.flat().map((c) => c.id).filter((id) => !gone.has(id)))];
      if (ids.length) tagged = (await ciApi.bulkTags(ids, { add: [tag] })).updatedIds?.length ?? 0;
    }
    ciApi.refreshMarinara(["characters", "gallery", "sprites", "lorebooks"]);
    ciLib.publishOwnedSoon();
    return { deleted, merged, tagged, problems };
  }

  return Object.freeze({ find, cleanup, loadBlockers, listBackups, restoreBackup, backupBlob, deleteBackup });
})();
