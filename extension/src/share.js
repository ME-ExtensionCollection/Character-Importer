// Char Importer: the small API other extensions use (Char Triage's "Tags you
// delete" list). window.marinaraCharImporter; check for the methods you need
// rather than the version number.

const ciShare = (() => {
  "use strict";

  const api = Object.freeze({
    version: 1,
    /** The profile tag blacklist, normalised (lowercase, underscores, no category). */
    profileTagBlacklist: () => {
      try {
        return [...ciSettings.get().profileTagBlacklist];
      } catch {
        return [];
      }
    },
    /** Whether a tag (any spelling) is on the profile tag blacklist. */
    isOnProfileTagBlacklist: (tag) => {
      const key = ciCore.normTag(tag);
      return !!key && api.profileTagBlacklist().includes(key);
    },
    /** Add tags to the profile tag blacklist. Resolves with the new list. */
    async addProfileTagBlacklist(tags) {
      await ciSettings.load();
      const list = [...ciSettings.get().profileTagBlacklist];
      for (const tag of [tags].flat()) {
        const key = ciCore.normTag(tag);
        if (key && !list.includes(key)) list.push(key);
      }
      ciSettings.set({ profileTagBlacklist: list });
      return [...list];
    },
  });

  function install() {
    window.marinaraCharImporter = api;
    marinara.onCleanup(() => {
      if (window.marinaraCharImporter === api) delete window.marinaraCharImporter;
    });
  }

  return Object.freeze({ install, api });
})();
