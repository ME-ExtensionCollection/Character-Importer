// Char Importer: the "Paste links" dialog.

const ciImportUi = (() => {
  "use strict";

  const { h, checkbox, dialog, toast, plural } = ciDom;
  let current = null;

  /**
   * @param {{tagImportMode?: string, regexScriptScope?: string, splitDescription?: boolean}} [prefill]
   *   options read from Marinara's own import dialog, when opened from there
   */
  async function open(prefill = {}) {
    if (current) return current;
    await ciSettings.load();
    const s = ciSettings.get();
    const opts = {
      preventDuplicates: s.preventDuplicates,
      contentCheck: s.contentCheck,
      downloadExpressions: s.downloadExpressions,
      localizeAssets: s.localizeAssets,
      downloadLorebooks: s.downloadLorebooks,
      tagImportMode: prefill.tagImportMode ?? s.tagImportMode,
      tagMerge: s.tagMerge,
      importEmbeddedLorebook: s.importEmbeddedLorebook,
      splitDescription: prefill.splitDescription ?? s.splitDescription,
      regexScriptScope: prefill.regexScriptScope ?? s.regexScriptScope,
    };

    const textarea = h("textarea", {
      class: "ci-input ci-links",
      rows: 6,
      spellcheck: false,
      placeholder: "One link per line\nhttps://chub.ai/characters/creator/name\nhttps://janitorai.com/characters/…\nhttps://botbooru.com/profile/… (queues all their cards)",
    });
    // After pasting, start a new line so the next link goes on its own line
    textarea.addEventListener("paste", () => {
      setTimeout(() => {
        const { value, selectionStart } = textarea;
        if (selectionStart === value.length && value && !value.endsWith("\n")) {
          textarea.value = `${value}\n`;
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
        updateCount();
      });
    });
    const count = h("span", { class: "ci-muted" });
    const updateCount = () => {
      const n = ciCore.parseLinks(textarea.value).length;
      count.textContent = n ? plural(n, "link") : "";
    };
    textarea.addEventListener("input", updateCount);

    const contentBox = checkbox("Also skip cards with identical content", opts.contentCheck, (v) => (opts.contentCheck = v), "Compares the card text with every card in the library, so the same card from another site or link is skipped too");
    const syncContent = () => contentBox.querySelector("input").toggleAttribute("disabled", !opts.preventDuplicates);
    const tagSelect = h(
      "select",
      { class: "ci-input ci-select", onChange: (e) => (opts.tagImportMode = e.currentTarget.value) },
      [["all", "Import all card tags"], ["existing", "Only tags I already use"], ["none", "No card tags"]].map(([value, label]) =>
        h("option", { value, text: label, selected: value === opts.tagImportMode }),
      ),
    );

    const d = dialog({
      title: "Import characters from links",
      wide: true,
      body: [
        h("p", { class: "ci-muted", text: "Chub, JanitorAI / JannyAI, Pygmalion, Wyvern, DataCat, RisuRealm, AICharacterCards, Chub lorebooks, or a direct link to a PNG / JSON card." }),
        textarea,
        h("div", { class: "ci-row ci-row--end" }, count),
        h(
          "div",
          { class: "ci-options" },
          checkbox("Prevent duplicates", opts.preventDuplicates, (v) => {
            opts.preventDuplicates = v;
            syncContent();
          }, "Skip links whose character is already in the library"),
          contentBox,
          checkbox("Download Chub expressions", opts.downloadExpressions, (v) => (opts.downloadExpressions = v), "Expression packs become the character's sprites"),
          checkbox("Save gallery & card images locally", opts.localizeAssets, (v) => (opts.localizeAssets = v), "Chub and Botbooru galleries and images in the card text are saved to the character's gallery"),
          checkbox("Download linked Chub lorebooks", opts.downloadLorebooks, (v) => (opts.downloadLorebooks = v)),
        ),
        h(
          "details",
          { class: "ci-details" },
          h("summary", { text: "Marinara import options" }),
          h(
            "div",
            { class: "ci-options" },
            h("label", { class: "ci-field" }, h("span", { text: "Card tags" }), tagSelect),
            checkbox(
              "Merge with Tag Merger canonicals",
              opts.tagMerge,
              (v) => (opts.tagMerge = v),
              "Tags that match a Tag Merger canonical become it (plus its implications) and always stay; other tags are tidied and follow Card tags",
            ),
            ciTags.available() ? null : h("p", { class: "ci-muted", text: "Tag Merger isn't enabled, so the merge option has no effect." }),
            checkbox("Import embedded lorebook", opts.importEmbeddedLorebook, (v) => (opts.importEmbeddedLorebook = v)),
            checkbox("Split description into sections", opts.splitDescription, (v) => (opts.splitDescription = v)),
          ),
        ),
      ],
      onClose: () => (current = null),
    });
    syncContent();
    current = d;

    const submit = () => {
      const links = ciCore.parseLinks(textarea.value);
      if (!links.length) {
        textarea.focus();
        return;
      }
      // What was ticked becomes the default next time
      ciSettings.set({
        preventDuplicates: opts.preventDuplicates,
        contentCheck: opts.contentCheck,
        downloadExpressions: opts.downloadExpressions,
        localizeAssets: opts.localizeAssets,
        downloadLorebooks: opts.downloadLorebooks,
        tagImportMode: opts.tagImportMode,
        tagMerge: opts.tagMerge,
        importEmbeddedLorebook: opts.importEmbeddedLorebook,
        splitDescription: opts.splitDescription,
      });
      const { added, alreadyQueued, joined } = ciQueue.add(links, opts);
      d.close(true);
      ciQueueUi.show();
      const extra = alreadyQueued ? ` (${plural(alreadyQueued, "link")} already queued)` : "";
      if (joined && added) toast(`${plural(added, "link")} added to the running import${extra}.`, "info");
      else if (!added) toast(`Nothing new to import${extra}.`, "info");
    };
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });
    d.setActions([
      { label: "Cancel", value: null },
      { label: "Import", kind: "primary", onClick: submit, title: "Ctrl+Enter" },
    ]);
    return d;
  }

  const close = () => current?.close(null);

  return Object.freeze({ open, close });
})();
