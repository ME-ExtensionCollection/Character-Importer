// Char Importer: settings and library tools (Marinara has no settings slot
// for full page extensions, so this is a dialog opened from the launcher).

const ciToolsUi = (() => {
  "use strict";

  const { h, icon, button, checkbox, dialog, confirm, toast, plural, ago, downloadBlob } = ciDom;
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
        setting("Save Botbooru galleries (needs a Botbooru login in this browser)", "botbooruGallery", "Read through the companion userscript with your Botbooru login. Part of \"Save gallery & card images locally\"."),
      ),
      section(
        "Botbooru repost accounts",
        h("p", {
          class: "ci-muted",
          text: "Archivist accounts that repost other people's cards, one username per line. Their cards still import (a repost can keep images the original lost), but one that differs from a card you have with the same name and creator is linked to it as a duplicate, and Flag duplicates keeps the author's copy rather than the repost.",
        }),
        (() => {
          const box = h("textarea", { class: "ci-input", rows: 4, spellcheck: false, value: ciSettings.get().botbooruRepostAccounts.join("\n"), placeholder: "username" });
          box.addEventListener("change", () =>
            ciSettings.set({ botbooruRepostAccounts: [...new Set(box.value.split(/\r?\n/).map((l) => l.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))] }),
          );
          return box;
        })(),
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
    // Groups whose copies differ: which copy to keep, and whether to merge the others into it
    const newest = (list) => [...list].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    const differingChoice = differing.map((g) => ({
      keeper: (g.find((c) => c.blocker) ?? newest(g.filter((c) => !c.repost)) ?? newest(g)).id,
      merge: false,
    }));
    const differingGroup = (g, i) => {
      const choice = differingChoice[i];
      const name = `ci-keep-${i}`;
      return h(
        "div",
        { class: "ci-dupe-set" },
        g.map((c) =>
          h(
            "label",
            { class: "ci-dupe-copy" },
            h("input", { type: "radio", name, checked: c.id === choice.keeper, onChange: () => (choice.keeper = c.id) }),
            h("span", { text: ` ${c.name || c.id}` }),
            h("span", {
              class: "ci-muted",
              text: [c.created ? ` added ${new Date(c.created).toLocaleString()}` : "", c.repost ? " · repost" : "", c.blocker ? ` · stays: ${c.blocker}` : ""].join(""),
            }),
          ),
        ),
        checkbox("Merge the others into the chosen copy (kept as obsolete)", false, (v) => (choice.merge = v),
          "Their gallery, sprites, tags and lorebook links move to the chosen copy; their links are kept on it as obsolete versions (still hidden, never imported again); each is backed up in this browser, then deleted"),
      );
    };
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
            h("p", {
              class: "ci-muted",
              text: "Probably different versions of a card, or a repost of it. The chosen copy (newest, not a repost, by default) is kept. Nothing is deleted unless you tick merge for a group.",
            }),
            h("div", { class: "ci-dupe-list" }, differing.map(differingGroup)),
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
          const obsoleteSets = differing
            .map((g, i) => ({ g, choice: differingChoice[i] }))
            .filter(({ choice }) => choice.merge)
            .map(({ g, choice }) => ({ keeper: g.find((c) => c.id === choice.keeper), remove: g.filter((c) => c.id !== choice.keeper && !c.blocker) }))
            .filter((s) => s.keeper && s.remove.length);
          const nObsolete = obsoleteSets.reduce((sum, s) => sum + s.remove.length, 0);
          const toDelete = (opts.del ? n : 0) + nObsolete;
          if (toDelete) {
            const parts = [opts.del && n ? `${plural(n, "identical copy", "identical copies")}` : "", nObsolete ? `${plural(nObsolete, "differing copy", "differing copies")} (their links kept as obsolete)` : ""].filter(Boolean);
            if (!(await confirm("Delete duplicates?", `Merge and delete ${parts.join(" and ")}? Each is backed up in this browser first (see the Backups tab).`, `Merge & delete ${toDelete}`, { kind: "danger" }))) return;
          }
          // Groups merged as obsolete aren't tagged
          const untagged = differing.filter((g, i) => !(differingChoice[i].merge && obsoleteSets.some((s) => s.keeper && g.includes(s.keeper))));
          d.setBusy(true);
          try {
            const result = await ciDupes.cleanup(chosen, { deleteCopies: opts.del, obsoleteSets, tagDiffering: opts.tag ? untagged : [], onStatus: (t) => (progress.textContent = t) });
            d.close(true);
            const parts = [`${result.merged} merged`, result.deleted ? `${result.deleted} deleted` : ""].filter(Boolean);
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

    // Jobs outlive this tab: progress and the end go to whichever Assets tab is on screen
    const runJob = async (fn, label) => {
      if (ciAssets.currentJob()) {
        ciAssets.stopJob();
        return;
      }
      if (ciQueue.isRunning()) {
        toast("Wait for the import queue to finish first.", "warn");
        return;
      }
      jobStatus = `${label}…`;
      refresh(true, label);
      const shown = () => (assetsView?.line.isConnected ? assetsView : null);
      let summary;
      try {
        const result = await fn({
          onStatus: (t) => {
            jobStatus = t;
            const v = shown();
            if (v) v.line.textContent = t;
          },
        });
        summary = summarize(label, result);
      } catch (error) {
        summary = ciNet.describe(error);
        toast(summary, "error");
      } finally {
        jobStatus = "";
        const v = shown();
        if (v) {
          v.refresh(false);
          v.line.textContent = summary ?? "";
          await v.showFailed();
          await v.showStMissing();
        } else if (summary) {
          toast(summary, "info");
        }
      }
    };
    const summarize = (label, r) => {
      if (!r) return "";
      if ("missing" in r) return `${label}: ${plural(r.cards, "card")}, ${plural(r.saved, "image")} saved (${r.gallery} Chub gallery), ${r.missing} card images not found${r.stopped ? " (stopped)" : ""}.`;
      if ("recovered" in r) return `${label}: ${r.done} / ${r.total} cards, ${plural(r.recovered, "image")} saved${r.stopped ? " (stopped)" : ""}.`;
      if ("marked" in r) {
        return `${label}: ${r.done} / ${plural(r.total, "Botbooru card")}, ${r.known} already known, ${r.marked} marked as downloaded` +
          `${r.updates.length ? `, ${plural(r.updates.length, "card")} changed since you imported ${r.updates.length === 1 ? "it" : "them"}` : ""}${r.stopped ? " (stopped)" : ""}.`;
      }
      if ("found" in r) return `${r.found} of ${plural(r.scanned, "card")} still link web images${r.stopped ? " (stopped)" : ""}.`;
      return `${label}: ${r.done} / ${plural(r.total, "card")}${r.warned ? `, ${r.warned} with warnings` : ""}${r.stopped ? " (stopped)" : ""}.`;
    };
    const fetchBtn = button("Fetch assets", () => runJob(ciAssets.backfill, "Fetch assets"), { kind: "primary", title: "Runs the ticked parts for every character that hasn't had them yet" });
    const retryBtn = button("Retry failed images", (e) => runJob(e.shiftKey ? ciAssets.scanUnsaved : ciAssets.retryFailed, e.shiftKey ? "Find unsaved images" : "Retry failed images"), {
      title: "Shift+click: only find cards that still link web images (downloads nothing)",
    });
    const viewBtn = button("View failed…", () => void viewFailed(showFailed));

    // Botbooru: its "Downloaded" filter only knows cards downloaded with your login
    const BB_JOB = "Tell Botbooru";
    const offerUpdates = async (links) => {
      const ok = await ciDom.confirm(
        "Changed on Botbooru",
        `${plural(links.length, "card")} changed on Botbooru since you imported ${links.length === 1 ? "it" : "them"}, so ${links.length === 1 ? "it wasn't" : "they weren't"} marked as downloaded. ` +
          "Queue the new versions? They're imported as new characters next to your copies; Flag duplicates groups each pair to compare.",
        "Queue them",
      );
      if (!ok) return;
      const s = ciSettings.get();
      const opts = {
        preventDuplicates: s.preventDuplicates, contentCheck: s.contentCheck, downloadExpressions: s.downloadExpressions,
        localizeAssets: s.localizeAssets, downloadLorebooks: s.downloadLorebooks, tagImportMode: s.tagImportMode, tagMerge: s.tagMerge,
        importEmbeddedLorebook: s.importEmbeddedLorebook, splitDescription: s.splitDescription, regexScriptScope: s.regexScriptScope,
      };
      ciQueue.add(links, opts, { recheck: true });
      ciQueueUi.show();
    };
    const botbooruBtn = button(
      "Tell Botbooru which cards you have",
      () => runJob(async (o) => {
        const result = await ciAssets.syncBotbooruDownloads(o);
        if (result.updates.length) void offerUpdates(result.updates);
        return result;
      }, BB_JOB),
      { title: "Cards Botbooru doesn't have as downloaded by you are downloaded once with your login and compared with your copy" },
    );

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
      // runJob calls this just before the job starts, so fall back to the label
      const active = running ? (ciAssets.currentJob()?.kind ?? label ?? null) : null;
      const mine = (kind) => active === kind;
      const other = (kind) => !!active && active !== kind;
      const isRetry = (kind) => kind === "Retry failed images" || kind === "Find unsaved images";
      fetchBtn.textContent = mine("Fetch assets") ? "Stop" : "Fetch assets";
      botbooruBtn.textContent = mine(BB_JOB) ? "Stop" : "Tell Botbooru which cards you have";
      botbooruBtn.disabled = other(BB_JOB);
      retryBtn.textContent = active && isRetry(active) ? "Stop" : "Retry failed images";
      stRestoreBtn.textContent = mine(ST_JOB) ? "Stop" : "Restore from folder";
      fetchBtn.disabled = other("Fetch assets");
      retryBtn.disabled = !!active && !isRetry(active);
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
      section(
        "Botbooru downloads",
        h("p", {
          class: "ci-muted",
          text: "Botbooru's \"Downloaded\" filter and \"Only updated\" view only know cards downloaded with your Botbooru login. This checks every Botbooru card in your library: ones Botbooru doesn't know about are downloaded once with your login and compared with your copy. Identical ones get marked; changed ones are offered as updates. Needs the companion userscript and your Botbooru login.",
        }),
        h("div", { class: "ci-row" }, botbooruBtn),
      ),
      h(
        "details",
        { class: "ci-details" },
        h("summary", { text: "SillyTavern import" }),
        h("p", {
          class: "ci-muted",
          text:
            "Cards imported from SillyTavern can point at images Dupe Link Skip saved on the SillyTavern server (/user/images/…), which Marinara doesn't have. " +
            "Pick SillyTavern's data/<user>/user/images folder to upload them from there. Files are matched by name, so images under numbered folders (Airi6 for Airi) are found too. Chub gallery images SillyTavern saved are uploaded as well, so Fetch assets skips them.",
        }),
        h("div", { class: "ci-row" }, stPickBtn, stPicked, stRestoreBtn),
        h("div", { class: "ci-row" }, h("span", { text: "Not found:" }), stMissingCount, stViewBtn),
      ),
      line,
    );
    assetsView = { line, refresh, showFailed, showStMissing };
    const job = ciAssets.currentJob();
    if (job) {
      refresh(true, job.kind);
      line.textContent = jobStatus || `${job.kind}…`;
    }
    await showFailed();
    await showStMissing();
  }

  // The Assets tab on screen, and the running job's last progress line
  let assetsView = null;
  let jobStatus = "";

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
                  h("ul", {}, Object.entries(item.paths).map(([path, entry]) => {
                    const { url, reason } = entry && typeof entry === "object" ? entry : { url: entry };
                    return h("li", {}, h("code", { text: path }), h("span", { class: "ci-muted", text: `${url ? ` ← ${url}` : " (no web link recorded)"}${reason ? ` · ${reason}` : ""}` }));
                  })),
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

  /**
   * Failed card images, with per-card actions: retry, open the editor, remove
   * the failed links (Marinara keeps a version), and fix a link by hand.
   * @param {() => Promise<void>} [onChange] refreshes the count on the Assets tab
   */
  async function viewFailed(onChange) {
    const expanded = new Set();
    const d = dialog({ title: "Card images not saved", wide: true });
    d.setActions([{ label: "Close", value: null }]);
    const iconBtn = (name, title, onClick) => h("button", { type: "button", class: "ci-icon-btn", title, "aria-label": title, onClick }, icon(name, 15));

    const render = async () => {
      const { list } = await ciAssets.failureSummary();
      if (!list.length) {
        d.setBody(h("p", { text: "Nothing failed." }));
        return;
      }
      // Runs one card action, then redraws the list with the same cards expanded
      const act = (fn) => async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const row = e.currentTarget.closest(".ci-failed");
        row?.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await fn();
        } catch (error) {
          toast(ciNet.describe(error), "error");
        }
        await onChange?.();
        await render();
      };
      d.setBody(
        h("p", { class: "ci-muted", text: `Hosts skipped for now: ${ciNet.downHosts().join(", ") || "none"}` }),
        h(
          "div",
          { class: "ci-failed-list" },
          list.map((item) => {
            const urls = Object.keys(item.urls);
            const retry = act(async () => {
              const r = await ciAssets.retryCard(item.id);
              toast(`${item.name}: ${plural(r.saved, "image")} saved, ${r.failed} still failing.`, r.failed ? "warn" : "success");
            });
            const openEditor = (e) => {
              e.preventDefault();
              e.stopPropagation();
              d.close(null);
              close();
              void ciInject.openCharacterEditor(item.id, item.name);
            };
            const remove = act(async () => {
              const ok = await confirm(
                "Remove failed image links",
                `Remove ${plural(urls.length, "image link")} from ${item.name}? Marinara keeps a version, so you can revert it from the card's history.`,
                "Remove",
                { kind: "danger" },
              );
              if (!ok) return;
              const n = await ciAssets.removeImageLinks(item.id, urls);
              toast(`${item.name}: removed ${plural(n, "image")}.`, "success");
            });
            const edit = (url) =>
              act(async () => {
                const next = await promptLink(url);
                if (!next) return;
                const r = await ciAssets.replaceImageLink(item.id, url, next);
                toast(`${item.name}: link fixed; ${plural(r.saved, "image")} saved, ${r.failed} still failing.`, r.failed ? "warn" : "success");
              });
            const details = h(
              "details",
              { class: "ci-failed", open: expanded.has(item.id), onToggle: (e) => (e.currentTarget.open ? expanded.add(item.id) : expanded.delete(item.id)) },
              h(
                "summary",
                { class: "ci-failed-head" },
                h("span", { class: "ci-grow", text: `${item.name} (${urls.length})` }),
                iconBtn("refresh", "Retry this card", retry),
                iconBtn("edit", "Open card editor", openEditor),
                iconBtn("trash", "Remove failed links from card", remove),
              ),
              h(
                "ul",
                {},
                Object.entries(item.urls).map(([url, f]) =>
                  h("li", { class: "ci-failed-link" }, iconBtn("pencil", "Edit link", edit(url)), h("code", { text: url }), h("span", { class: "ci-muted", text: ` ${f.reason}` })),
                ),
              ),
            );
            return details;
          }),
        ),
      );
    };
    await render();
  }

  /** Asks for a corrected link. @returns {Promise<string|null>} */
  async function promptLink(url) {
    const input = h("input", { class: "ci-input", type: "url", value: url, spellcheck: false });
    const error = h("p", { class: "ci-error", hidden: true });
    const d = dialog({ title: "Edit image link", wide: true, body: [h("p", { class: "ci-muted", text: "Fix the link, then the card's images are tried again. Marinara keeps a version of the card." }), input, error] });
    const save = () => {
      const next = input.value.trim();
      const problem = !/^https?:\/\/\S+$/.test(next) ? "Enter an http or https link." : next === url ? "The link hasn't changed." : "";
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      d.close(next);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), save()));
    d.setActions([{ label: "Cancel", value: null }, { label: "Save & retry", kind: "primary", onClick: save }]);
    setTimeout(() => input.focus(), 0);
    return (await d.result) ?? null;
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
