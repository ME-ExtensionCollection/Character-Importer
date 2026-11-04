// Char Importer: settings and library tools (Marinara has no settings slot
// for full page extensions, so this is a dialog opened from the launcher).

const ciToolsUi = (() => {
  "use strict";

  const { h, button, checkbox, dialog, confirm, toast, plural, ago, downloadBlob } = ciDom;
  let current = null;
  let tab = "import";

  const TABS = [
    ["import", "Import"],
    ["library", "Library"],
    ["assets", "Assets"],
    ["links", "Asset links"],
    ["companion", "Companion"],
    ["backups", "Backups"],
  ];

  async function open(initialTab) {
    await ciSettings.load();
    if (initialTab) tab = initialTab;
    if (current) {
      render();
      return current;
    }
    current = dialog({ title: "Char Importer", wide: true, onClose: () => (current = null) });
    current.setActions([
      { label: "Show import queue", onClick: () => ciQueueUi.show() },
      { label: "Paste links…", kind: "primary", onClick: () => void ciImportUi.open() },
    ]);
    render();
    return current;
  }

  const close = () => current?.close(null);

  function render() {
    if (!current) return;
    const nav = h(
      "div",
      { class: "ci-tabs", role: "tablist" },
      TABS.map(([id, label]) => h("button", { type: "button", role: "tab", class: `ci-tab${id === tab ? " is-active" : ""}`, "aria-selected": String(id === tab), onClick: () => ((tab = id), render()), text: label })),
    );
    const pane = h("div", { class: "ci-pane" });
    current.setBody(nav, pane);
    const build = { import: importTab, library: libraryTab, assets: assetsTab, links: linksTab, companion: companionTab, backups: backupsTab }[tab];
    Promise.resolve(build(pane)).catch((error) => {
      pane.replaceChildren(h("p", { class: "ci-error", text: ciNet.describe(error) }));
    });
  }

  const section = (title, ...children) => h("section", { class: "ci-section" }, h("h4", { text: title }), children);
  const setting = (label, key, title) => checkbox(label, ciSettings.get()[key], (v) => ciSettings.set({ [key]: v }), title);
  const status = () => h("p", { class: "ci-status ci-muted", "aria-live": "polite" });

  function textSetting(label, key, placeholder) {
    return h(
      "label",
      { class: "ci-field" },
      h("span", { text: label }),
      h("input", { class: "ci-input", type: "text", value: ciSettings.get()[key] ?? "", placeholder, onChange: (e) => ciSettings.set({ [key]: e.currentTarget.value.trim() }) }),
    );
  }

  // ── Import ──

  function importTab(pane) {
    pane.append(
      section(
        "Defaults for the paste dialog",
        h("p", { class: "ci-muted", text: "The dialog remembers what you ticked last time; these are the same switches." }),
        setting("Prevent duplicates", "preventDuplicates"),
        setting("Also skip cards with identical content", "contentCheck"),
        setting("Download Chub expressions", "downloadExpressions"),
        setting("Save gallery & card images locally", "localizeAssets"),
        setting("Download linked Chub lorebooks", "downloadLorebooks"),
      ),
      section(
        "Tags this importer adds",
        textSetting("Characters with a downloaded expression pack", "expressionsTag", "empty = no tag"),
        textSetting("Characters whose notes link extra assets", "assetLinksTag", "empty = no tag"),
        textSetting("Copies that share a link but differ (Flag duplicates)", "duplicateTag", "empty = no tag"),
      ),
      section(
        "Behaviour",
        setting("Floating button when Marinara's top bar is hidden", "floatingButton"),
        setting("Download blocked sprite images through a temporary gallery copy", "serverImageProxy", "Marinara's server fetches the image into the gallery, the extension reads it and removes the copy. Used before the companion userscript."),
      ),
    );
  }

  // ── Library ──

  async function libraryTab(pane) {
    const line = status();
    const showStatus = async () => {
      const s = await ciLib.status();
      line.textContent = `Scanned ${plural(s.count, "character")} (${s.withKeys} with source links, ${s.withHash} with content). Last scan: ${ago(s.updated)}.`;
    };
    const runScan = async (full) => {
      setBusy(true);
      try {
        await ciLib.refresh({ full, onProgress: (text) => (line.textContent = text) });
        ciLib.publishOwnedSoon();
      } catch (error) {
        toast(ciNet.describe(error), "error");
      } finally {
        setBusy(false);
        await showStatus();
      }
    };
    const buttons = [
      button("Load new", () => runScan(false), { title: "Scan characters added or changed since the last scan" }),
      button("Rebuild all", () => runScan(true), { title: "Forget the index and scan every character again" }),
      button("Flag duplicates…", () => void flagDuplicates(line), { kind: "primary" }),
    ];
    const setBusy = (busy) => buttons.forEach((b) => (b.disabled = busy));
    pane.append(
      section(
        "Library index",
        h("p", { class: "ci-muted", text: "Source links and content hashes of every character, used to skip duplicates. Refreshed automatically before each import run." }),
        h("div", { class: "ci-row" }, buttons),
        line,
      ),
    );
    await showStatus();
  }

  async function flagDuplicates(line) {
    let found;
    try {
      found = await ciDupes.find((text) => (line.textContent = text));
    } catch (error) {
      toast(ciNet.describe(error), "error");
      return;
    }
    line.textContent = "";
    const { sets, differing, similar } = found;
    if (!sets.length && !differing.length && !similar.length) {
      toast("No duplicates found.", "success");
      return;
    }
    const remove = new Set(sets.flatMap((s) => s.remove.map((c) => c.id)));
    const opts = { merge: true, del: true, tag: true };
    const copyLine = (c, role) =>
      h("div", { class: "ci-dupe-copy" },
        role === "remove"
          ? checkbox(c.name || c.id, true, (v) => (v ? remove.add(c.id) : remove.delete(c.id)), "Untick to keep this copy")
          : h("span", { class: role === "keeper" ? "ci-dupe-keeper" : "ci-muted", text: c.name || c.id }),
        h("span", { class: "ci-muted", text: [c.created ? ` added ${new Date(c.created).toLocaleString()}` : "", role === "keeper" ? " · keeps everything" : role === "kept" ? ` · stays: ${c.blocker}` : ""].join("") }),
      );
    const body = [
      sets.length
        ? section(
            `Identical copies (${sets.length})`,
            h("p", { class: "ci-muted", text: "Ticked copies are merged into the first one (gallery, sprites, tags, favorite, lorebook links), backed up in this browser, then deleted. Copies used in chats or groups always stay." }),
            h("div", { class: "ci-dupe-list" }, sets.map((s) => h("div", { class: "ci-dupe-set" }, copyLine(s.keeper, "keeper"), s.remove.map((c) => copyLine(c, "remove")), s.kept.map((c) => copyLine(c, "kept"))))),
            checkbox("Delete merged copies (unticked: merge only)", opts.del, (v) => (opts.del = v)),
          )
        : null,
      differing.length
        ? section(
            `Same link, different content (${differing.length})`,
            h("p", { class: "ci-muted", text: "Probably different versions of a card. Nothing is deleted." }),
            h("div", { class: "ci-dupe-list" }, differing.map((g) => h("div", { class: "ci-dupe-set" }, g.map((c) => h("div", { class: "ci-dupe-copy", text: c.name || c.id }))))),
            ciSettings.get().duplicateTag ? checkbox(`Tag them "${ciSettings.get().duplicateTag}"`, opts.tag, (v) => (opts.tag = v)) : null,
          )
        : null,
      similar.length
        ? section(
            `Similar by name or description (${similar.length}, from Marinara)`,
            h("p", { class: "ci-muted", text: "Not matched by link or content; review them in Marinara's library. Shown for information only." }),
            h("div", { class: "ci-dupe-list" }, similar.slice(0, 50).map((g) => h("div", { class: "ci-dupe-set" }, (g.characters ?? []).map((c) => h("div", { class: "ci-dupe-copy", text: `${c.name}${c.creator ? ` by ${c.creator}` : ""}` }))))),
          )
        : null,
    ];
    const d = dialog({ title: "Flag duplicates", wide: true, body });
    const progress = status();
    d.body.append(progress);
    d.setActions([
      { label: "Cancel", value: null },
      {
        label: "Apply",
        kind: "primary",
        onClick: async () => {
          const chosen = sets.map((s) => ({ keeper: s.keeper, remove: s.remove.filter((c) => remove.has(c.id)) })).filter((s) => s.remove.length);
          const n = chosen.reduce((sum, s) => sum + s.remove.length, 0);
          if (opts.del && n && !(await confirm("Delete duplicates?", `Merge and delete ${plural(n, "copy", "copies")}? Each is backed up in this browser first (see the Backups tab).`, `Merge & delete ${n}`, { kind: "danger" }))) return;
          d.setBusy(true);
          try {
            const result = await ciDupes.cleanup(chosen, { deleteCopies: opts.del, tagDiffering: opts.tag ? differing : [], onStatus: (t) => (progress.textContent = t) });
            d.close(true);
            const parts = [opts.del ? `${result.deleted} deleted` : `${result.merged} merged`];
            if (result.tagged) parts.push(`${result.tagged} tagged`);
            toast(`Duplicates: ${parts.join(", ")}.`, result.problems.length ? "warn" : "success");
            if (result.problems.length) {
              const p = dialog({ title: "Some copies were not removed", body: [h("ul", {}, result.problems.map((t) => h("li", { text: t })))] });
              p.setActions([{ label: "OK", value: true, kind: "primary" }]);
            }
          } catch (error) {
            d.setBusy(false);
            toast(ciNet.describe(error), "error");
          }
        },
      },
    ]);
  }

  // ── Assets ──

  async function assetsTab(pane) {
    const s = ciSettings.get();
    const line = status();
    const parts = s.backfillParts;
    const part = (label, key) => checkbox(label, parts[key], (v) => ciSettings.set({ backfillParts: { ...ciSettings.get().backfillParts, [key]: v } }));
    const failedCount = h("span", { class: "ci-muted" });
    const showFailed = async () => {
      const f = await ciAssets.failureSummary();
      failedCount.textContent = f.cards ? `(${plural(f.cards, "card")}, ${plural(f.images, "image")})` : "(none)";
    };

    const runJob = async (fn, label) => {
      if (ciAssets.currentJob()) {
        ciAssets.stopJob();
        return;
      }
      if (ciQueue.isRunning()) {
        toast("Wait for the import queue to finish first.", "warn");
        return;
      }
      refresh(true, label);
      try {
        const result = await fn({ onStatus: (t) => (line.textContent = t) });
        line.textContent = summarize(label, result);
      } catch (error) {
        line.textContent = ciNet.describe(error);
        toast(ciNet.describe(error), "error");
      } finally {
        refresh(false);
        await showFailed();
        await showStMissing();
      }
    };
    const summarize = (label, r) => {
      if (!r) return "";
      if ("missing" in r) return `${label}: ${plural(r.cards, "card")}, ${plural(r.saved, "image")} saved, ${r.missing} not found${r.stopped ? " (stopped)" : ""}.`;
      if ("recovered" in r) return `${label}: ${r.done} / ${r.total} cards, ${plural(r.recovered, "image")} saved${r.stopped ? " (stopped)" : ""}.`;
      if ("found" in r) return `${r.found} of ${plural(r.scanned, "card")} still link web images${r.stopped ? " (stopped)" : ""}.`;
      return `${label}: ${r.done} / ${plural(r.total, "card")}${r.warned ? `, ${r.warned} with warnings` : ""}${r.stopped ? " (stopped)" : ""}.`;
    };
    const fetchBtn = button("Fetch assets", () => runJob(ciAssets.backfill, "Fetch assets"), { kind: "primary", title: "Runs the ticked parts for every character that hasn't had them yet" });
    const retryBtn = button("Retry failed images", (e) => runJob(e.shiftKey ? ciAssets.scanUnsaved : ciAssets.retryFailed, e.shiftKey ? "Find unsaved images" : "Retry failed images"), {
      title: "Shift+click: only find cards that still link web images (downloads nothing)",
    });
    const viewBtn = button("View failed…", () => void viewFailed());

    // SillyTavern import: images Dupe Link Skip saved on the ST server
    const ST_JOB = "Restore SillyTavern images";
    const stPicked = h("span", { class: "ci-muted", text: stFolder ? `${plural(stFolder.size, "file")} picked` : "No folder picked" });
    const stMissingCount = h("span", { class: "ci-muted" });
    const showStMissing = async () => {
      const m = await ciAssets.stMissingSummary();
      stMissingCount.textContent = m.cards ? `${plural(m.cards, "card")}, ${plural(m.images, "image")}` : "none";
    };
    const stRestoreBtn = button("Restore from folder", () => runJob((o) => ciAssets.restoreStJob({ ...o, index: stFolder }), ST_JOB), {
      kind: "primary",
      disabled: !stFolder,
      title: "Uploads the picked copies into each character's gallery and points the card text at them",
    });
    const stPickBtn = button("Choose images folder…", async () => {
      const index = await pickStFolder();
      if (!index) return;
      stFolder = index;
      stPicked.textContent = `${plural(index.size, "file")} picked`;
      stRestoreBtn.disabled = !!ciAssets.currentJob();
    });
    const stViewBtn = button("View not found…", () => void viewStMissing(async () => {
      await showStMissing();
      await showFailed();
    }));

    const refresh = (running, label) => {
      const job = ciAssets.currentJob();
      const mine = (kind) => running && job?.kind === kind;
      const other = (kind) => running && !!job && job.kind !== kind;
      const isRetry = (kind) => kind === "Retry failed images" || kind === "Find unsaved images";
      fetchBtn.textContent = mine("Fetch assets") ? "Stop" : "Fetch assets";
      retryBtn.textContent = running && job && isRetry(job.kind) ? "Stop" : "Retry failed images";
      stRestoreBtn.textContent = mine(ST_JOB) ? "Stop" : "Restore from folder";
      fetchBtn.disabled = other("Fetch assets");
      retryBtn.disabled = running && !!job && !isRetry(job.kind);
      stRestoreBtn.disabled = other(ST_JOB) || (!stFolder && !mine(ST_JOB));
      if (running && label) line.textContent = `${label}…`;
    };

    pane.append(
      section(
        "Fetch assets for the whole library",
        h("p", { class: "ci-muted", text: "For characters imported before, or with these steps turned off. Each part runs once per character; stopping and starting again continues where it left off." }),
        h("div", { class: "ci-options" }, part("Chub expressions", "expressions"), part("Chub gallery", "gallery"), part("Chub lorebooks", "lorebooks"), part("Card images", "images"), part("Asset links", "links")),
        setting("Also ask Chub about cards saved without an expression pack", "checkAddedPacks"),
        h("div", { class: "ci-row" }, fetchBtn),
      ),
      section("Card images that could not be saved", h("div", { class: "ci-row" }, retryBtn, failedCount, viewBtn)),
      h(
        "details",
        { class: "ci-details" },
        h("summary", { text: "SillyTavern import" }),
        h("p", {
          class: "ci-muted",
          text:
            "Cards imported from SillyTavern can point at images Dupe Link Skip saved on the SillyTavern server (/user/images/…), which Marinara doesn't have. " +
            "Pick SillyTavern's data/<user>/user/images folder to upload them from there. Files are matched by name, so images under numbered folders (Airi6 for Airi) are found too.",
        }),
        h("div", { class: "ci-row" }, stPickBtn, stPicked, stRestoreBtn),
        h("div", { class: "ci-row" }, h("span", { text: "Not found:" }), stMissingCount, stViewBtn),
      ),
      line,
    );
    const job = ciAssets.currentJob();
    if (job) refresh(true, job.kind);
    await showFailed();
    await showStMissing();
  }

  // Picked SillyTavern images folder; kept until reload
  let stFolder = null;

  /** Opens a folder picker. @returns {Promise<object|null>} ciCore.stFileIndex of the picked files */
  function pickStFolder() {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", multiple: true, hidden: true });
      input.webkitdirectory = true;
      input.addEventListener("change", () => {
        const files = [...(input.files ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
        input.remove();
        resolve(files.length ? ciCore.stFileIndex(files) : null);
      });
      input.addEventListener("cancel", () => {
        input.remove();
        resolve(null);
      });
      document.body.append(input);
      input.click();
    });
  }

  async function viewStMissing(onChange) {
    const { list } = await ciAssets.stMissingSummary();
    let d;
    const busy = (fn) => async (e) => {
      const btn = e?.currentTarget;
      if (ciAssets.currentJob()) {
        toast("Wait for the running job to finish first.", "warn");
        return;
      }
      if (btn) btn.disabled = true;
      try {
        await fn();
      } catch (error) {
        toast(ciNet.describe(error), "error");
      } finally {
        await onChange?.();
        d?.close(null);
        void viewStMissing(onChange);
      }
    };
    const pickFor = (item) => busy(async () => {
      const index = await pickStFolder();
      if (!index) return;
      const r = await ciAssets.restoreStCard(item.id, index);
      toast(`${item.name}: ${plural(r.saved, "image")} saved, ${r.missing} still not found.`, r.missing ? "warn" : "success");
    });
    const reset = (ids) => busy(async () => {
      const r = await ciAssets.resetStLinks(ids);
      toast(`Web links restored on ${plural(r.cards, "card")} (${plural(r.links, "link")}); they're listed under failed images for Retry.`, "success");
    });
    d = dialog({
      title: "SillyTavern images not found",
      wide: true,
      body: list.length
        ? [
            h("p", { class: "ci-muted", text: "Pick the folder that has a card's images, or reset its links to the original web links. Reset links are retried by Retry failed images. Paths with no recorded web link can only be restored from a folder." }),
            h(
              "div",
              { class: "ci-failed-list" },
              list.map((item) =>
                h("details", { class: "ci-failed" },
                  h("summary", { text: `${item.name} (${Object.keys(item.paths).length})` }),
                  h("div", { class: "ci-row" }, button("Pick folder…", pickFor(item)), button("Reset links", reset([item.id]))),
                  h("ul", {}, Object.entries(item.paths).map(([path, url]) => h("li", {}, h("code", { text: path }), h("span", { class: "ci-muted", text: url ? ` ← ${url}` : " (no web link recorded)" })))),
                ),
              ),
            ),
          ]
        : [h("p", { text: "Nothing missing." })],
    });
    d.setActions([
      ...(list.length ? [{ label: "Reset all to web links", onClick: () => void reset(list.map((i) => i.id))() }] : []),
      { label: "Close", value: null },
    ]);
  }

  async function viewFailed() {
    const { list } = await ciAssets.failureSummary();
    const d = dialog({
      title: "Card images not saved",
      wide: true,
      body: list.length
        ? [
            h("p", { class: "ci-muted", text: `Hosts skipped for now: ${ciNet.downHosts().join(", ") || "none"}` }),
            h(
              "div",
              { class: "ci-failed-list" },
              list.map((item) =>
                h("details", { class: "ci-failed" },
                  h("summary", { text: `${item.name} (${Object.keys(item.urls).length})` }),
                  h("ul", {}, Object.entries(item.urls).map(([url, f]) => h("li", {}, h("code", { text: url }), h("span", { class: "ci-muted", text: ` ${f.reason}` })))),
                ),
              ),
            ),
          ]
        : [h("p", { text: "Nothing failed." })],
    });
    d.setActions([{ label: "Close", value: null }]);
  }

  // ── Asset links ──

  async function linksTab(pane) {
    const s = ciSettings.get();
    const all = await ciAssets.linksStore.all();
    const index = await ciLib.load();
    const entries = Object.entries(all).filter(([id]) => index[id]);
    const dismiss = async (urls) => {
      ciSettings.set({ dismissedLinks: [...new Set([...ciSettings.get().dismissedLinks, ...urls])] });
      await ciAssets.pruneAssetLinks();
      render();
    };
    const block = async (url) => {
      const host = ciNet.hostOf(url).replace(/^www\./, "");
      if (!host) return;
      ciSettings.set({ linkBlacklist: [...new Set([...ciSettings.get().linkBlacklist, host])] });
      await ciAssets.pruneAssetLinks();
      render();
    };
    const blacklist = h("textarea", { class: "ci-input", rows: 6, spellcheck: false, value: s.linkBlacklist.join("\n") });
    blacklist.addEventListener("change", async () => {
      ciSettings.set({ linkBlacklist: blacklist.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) });
      await ciAssets.pruneAssetLinks();
    });
    pane.append(
      section(
        `Characters with asset links (${entries.length})`,
        h("p", { class: "ci-muted", text: "Links in creator notes that look like sprite packs, archives or file hosts. Download them by hand; dismiss what you've handled." }),
        entries.length
          ? h(
              "div",
              { class: "ci-links-list" },
              entries.map(([id, found]) =>
                h(
                  "details",
                  { class: "ci-failed" },
                  h("summary", {}, `${index[id].name} (${found.length}) `, h("button", { type: "button", class: "ci-link-btn", text: "dismiss all", onClick: (e) => (e.preventDefault(), void dismiss(found.map((f) => f.url))) })),
                  h(
                    "ul",
                    {},
                    found.map((f) =>
                      h(
                        "li",
                        {},
                        h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", text: f.url }),
                        " ",
                        h("button", { type: "button", class: "ci-link-btn", text: "dismiss", onClick: () => void dismiss([f.url]) }),
                        h("button", { type: "button", class: "ci-link-btn", text: "block site", onClick: () => void block(f.url) }),
                        h("div", { class: "ci-muted ci-context", text: f.context }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h("p", { class: "ci-muted", text: "None found yet." }),
      ),
      section("Ignore links to these sites", h("p", { class: "ci-muted", text: "One per line. A site name also covers its subdomains; an entry with / matches part of a link." }), blacklist),
    );
  }

  // ── Companion userscript ──

  async function companionTab(pane) {
    const info = await ciBridge.detect(600);
    const line = status();
    const testUrl = h("input", { class: "ci-input", type: "url", value: "https://avatars.charhub.io/avatars/uploads/images/gallery/file/0.png", placeholder: "https://…" });
    pane.append(
      section(
        "Companion userscript",
        h("p", {
          class: info ? "" : "ci-warn",
          text: info
            ? `Connected: ${info.name} ${info.version} (${info.hostPolicy === "known" ? "known sites only" : "any public site"}, up to ${Math.round(info.maxBytes / 1048576)} MB).`
            : "Not detected. Without it, sites that block downloads from this page (most image hosts, RisuRealm, AICharacterCards) can't be fetched, and owned Chub cards aren't hidden on Chub.",
        }),
        h("p", { class: "ci-muted", text: "Install userscript/CharImporter-companion.user.js from this extension's folder in Violentmonkey or Tampermonkey, and add an @match line for this page's address (e.g. *://192.168.1.10:7860/*, which covers http and https) if it isn't 127.0.0.1 or localhost on port 7860 or 8000. It replaces the Dupe Link Skip Chub userscript and works for SillyTavern too." }),
        h("div", { class: "ci-row" }, button("Check again", () => render()), button("Send owned list now", async () => {
          await ciLib.publishOwned();
          toast("Owned Chub list sent to the userscript.", "success");
        })),
      ),
      section(
        "Chub in another browser",
        h("p", {
          class: "ci-muted",
          text:
            "To hide owned cards in a browser that doesn't have Marinara open, copy this address into the userscript menu there (\"Char Importer: set Marinara sync address\"). " +
            "If Marinara runs on that same computer, use 127.0.0.1 as the host so no login is needed; otherwise sign in to Marinara once in that browser.",
        }),
        (() => {
          const field = h("input", { class: "ci-input", type: "text", value: ciLib.syncAddress(), readOnly: true, onFocus: (e) => e.target.select() });
          return h("div", { class: "ci-row" }, field, button("Copy", async () => {
            try {
              await navigator.clipboard.writeText(field.value);
              toast("Sync address copied.", "success");
            } catch {
              field.select();
              toast("Couldn't copy; the address is selected, copy it with Ctrl+C.", "warn");
            }
          }));
        })(),
      ),
      section(
        "Test a download",
        h("div", { class: "ci-row" }, testUrl, button("Fetch", async () => {
          line.textContent = "Fetching…";
          try {
            const r = await ciNet.fetchRemote(testUrl.value.trim(), { timeoutMs: 20_000 });
            line.textContent = `OK via ${r.via}: ${plural(r.bytes.length, "byte")}, ${r.contentType || "unknown type"}.`;
          } catch (error) {
            line.textContent = `Failed: ${ciNet.describe(error)}`;
          }
        })),
        line,
      ),
    );
  }

  // ── Backups ──

  async function backupsTab(pane) {
    const backups = await ciDupes.listBackups();
    pane.append(
      section(
        `Backups of deleted duplicates (${backups.length})`,
        h("p", { class: "ci-muted", text: "Marinara exports of every copy Flag duplicates deleted, kept in this browser. Restore imports it as a new character." }),
        backups.length
          ? h(
              "table",
              { class: "ci-table" },
              h("tbody", {}, backups.map((b) =>
                h("tr", {},
                  h("td", { text: b.name || b.id }),
                  h("td", { class: "ci-muted", text: new Date(b.at).toLocaleString() }),
                  h("td", { class: "ci-muted", text: `${Math.round(b.size / 1024)} KB` }),
                  h("td", { class: "ci-row ci-row--end" },
                    button("Download", async () => {
                      const { blob, filename } = await ciDupes.backupBlob(b.key);
                      downloadBlob(blob, filename);
                    }),
                    button("Restore", async () => {
                      try {
                        await ciDupes.restoreBackup(b.key);
                        toast(`${b.name} restored.`, "success");
                      } catch (error) {
                        toast(ciNet.describe(error), "error");
                      }
                    }),
                    button("Delete", async () => {
                      if (!(await confirm("Delete backup?", `The backup of ${b.name} will be gone for good.`, "Delete", { kind: "danger" }))) return;
                      await ciDupes.deleteBackup(b.key);
                      render();
                    }, { kind: "danger" }),
                  ),
                ),
              )),
            )
          : h("p", { class: "ci-muted", text: "No backups." }),
      ),
    );
  }

  return Object.freeze({ open, close, render });
})();
