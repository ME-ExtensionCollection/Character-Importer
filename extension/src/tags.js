// Char Importer: card tags through the Tag Merger extension. Tag Merger
// publishes window.marinaraTagMerger when it is enabled; tags a canonical
// claims become that canonical (plus implications), and the rest are tidied
// and then follow the Card tags mode.

const ciTags = (() => {
  "use strict";

  let existing = null; // Promise<Set<string>> of tag keys in the library, per queue run

  const api = () => (window.marinaraTagMerger?.version === 1 ? window.marinaraTagMerger : null);
  const available = () => !!api();

  /** Forget the library's tags, so the next "existing" check reads them again. */
  function reset() {
    existing = null;
  }

  function existingKeys() {
    existing ??= ciApi.listCatalog().then(({ items }) => {
      const keys = new Set();
      for (const item of items) for (const tag of Array.isArray(item.tags) ? item.tags : []) if (typeof tag === "string") keys.add(ciCore.tagKey(tag));
      return keys;
    });
    existing.catch(() => (existing = null));
    return existing;
  }

  /** Tags just written to a card count as existing for the rest of the run. */
  function add(tags) {
    void existing?.then((keys) => tags.forEach((t) => keys.add(ciCore.tagKey(t))), () => undefined);
  }

  /**
   * @param {unknown} cardTags the card's own tags
   * @param {"all"|"existing"|"none"} mode
   * @returns {Promise<{tags: string[], merged: number} | null>} null when Tag Merger isn't enabled
   */
  async function finalTags(cardTags, mode) {
    const merger = api();
    if (!merger) return null;
    const list = Array.isArray(cardTags) ? cardTags.filter((t) => typeof t === "string") : [];
    const mapped = await merger.mapTags(list);
    const keys = mode === "existing" ? await existingKeys() : undefined;
    const tags = ciCore.composeImportTags(mapped, mode, keys);
    // Card tags that came out spelled differently, or were added by an implication
    const before = new Set(list.map((t) => t.trim()));
    const merged = (mapped.canonical ?? []).filter((t) => !before.has(t)).length;
    return { tags, merged };
  }

  return Object.freeze({ available, reset, add, finalTags });
})();
