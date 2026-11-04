// Char Importer: settings, saved in marinara.storage (server side, follows the
// Marinara install rather than the browser).

const ciSettings = (() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    preventDuplicates: true,
    // Also skip cards whose content matches one already in the library
    contentCheck: false,
    downloadExpressions: true,
    downloadLorebooks: true,
    // Save Chub gallery and images embedded in card text locally
    localizeAssets: true,
    // Fetch assets also asks Chub about cards saved without a pack
    checkAddedPacks: false,
    expressionsTag: "EXP Downloaded",
    assetLinksTag: "Asset links",
    duplicateTag: "Possible duplicate",
    linkBlacklist: [...ciCore.DEFAULT_LINK_BLACKLIST],
    dismissedLinks: [],
    backfillParts: { expressions: true, gallery: true, images: true, links: true, lorebooks: true },
    // Marinara import options
    tagImportMode: "all",
    // Tidy card tags with the Tag Merger extension's canonicals
    tagMerge: false,
    importEmbeddedLorebook: true,
    splitDescription: false,
    regexScriptScope: "character",
    // Fallback launcher when the top bar isn't there (mobile layouts)
    floatingButton: true,
    // Image bytes may be fetched through a temporary gallery copy when direct download is blocked
    serverImageProxy: true,
    // Chub lorebook path -> Marinara lorebook id
    lorebooks: {},
  });

  let current = null;
  let loading = null;
  let saveTimer = 0;
  let pending = {};

  function merge(saved) {
    const out = structuredClone(DEFAULTS);
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (!(key in DEFAULTS) || value === undefined || value === null) continue;
      if (key === "backfillParts" && typeof value === "object") out.backfillParts = { ...out.backfillParts, ...value };
      else out[key] = value;
    }
    return out;
  }

  async function load() {
    if (current) return current;
    loading ??= marinara.storage.get().then(
      (saved) => (current = merge(saved?.settings)),
      (error) => {
        marinara.log.warn("Char Importer could not read its settings, using defaults", error);
        return (current = merge(null));
      },
    );
    return loading;
  }

  /** Current settings (call load() once first). */
  function get() {
    if (!current) throw new Error("Char Importer settings are not loaded yet");
    return current;
  }

  /** Change settings; saved shortly after. */
  function set(patch) {
    Object.assign(get(), patch);
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), 500);
  }

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!current || !Object.keys(pending).length) return;
    pending = {};
    try {
      await marinara.storage.patch({ settings: current });
    } catch (error) {
      marinara.log.error("Char Importer could not save its settings", error);
    }
  }

  return Object.freeze({ DEFAULTS, load, get, set, flush });
})();
