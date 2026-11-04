// Char Importer: places our buttons in Marinara's page and puts them back
// whenever React re-renders them away. Full page extensions get no
// registerContribution, so these are DOM anchors:
//   - a launcher in the top bar (same classes as Marinara's own buttons)
//   - a "Paste links" card at the top of Marinara's Import Character dialog
//   - a small floating button when the top bar isn't there (mobile layouts)

const ciInject = (() => {
  "use strict";

  const { h, icon } = ciDom;
  const NAV_SELECTOR = 'nav[data-tour="panel-buttons"]';
  const SETTINGS_SELECTOR = '[data-tour="panel-settings"]';
  // Marinara's Import Character dialog is the only modal with these radios
  const IMPORT_RADIO_SELECTOR = '[data-component="Modal"] input[name="regexScriptScope"]';

  let observer = null;
  let frame = 0;
  let floatTimer = 0;

  const launcher = h(
    "button",
    {
      type: "button",
      class: "ci-launcher mari-topbar-action relative flex h-8 w-8 items-center justify-center rounded-lg p-0 transition-all duration-200 text-[var(--muted-foreground)] hover:bg-[var(--accent)]",
      title: "Char Importer (click: paste links, right-click: tools)",
      "aria-label": "Char Importer: import characters from links",
      onClick: (e) => (e.shiftKey ? void ciToolsUi.open() : void ciImportUi.open()),
      onContextmenu: (e) => {
        e.preventDefault();
        void ciToolsUi.open();
      },
    },
    icon("import", 15, "mari-topbar-accent-icon mari-accent-animated"),
    h("span", { class: "ci-badge", hidden: true }),
  );

  const floating = h(
    "button",
    { type: "button", class: "ci-root ci-fab", title: "Char Importer", "aria-label": "Char Importer", onClick: () => void ciImportUi.open(), onContextmenu: (e) => (e.preventDefault(), void ciToolsUi.open()) },
    icon("import", 18),
  );

  function readImportOptions(scope) {
    const checked = (name) => scope.querySelector(`input[name="${name}"]:checked`)?.value;
    const split = [...scope.querySelectorAll('label input[type="checkbox"]')].find((input) => !input.closest(".ci-modal-card"));
    return {
      tagImportMode: checked("tagImportMode"),
      regexScriptScope: checked("regexScriptScope"),
      splitDescription: split ? split.checked : undefined,
    };
  }

  function syncImportModal() {
    const radio = document.querySelector(IMPORT_RADIO_SELECTOR);
    if (!radio) return;
    const modal = radio.closest('[data-component="Modal"]');
    if (!modal || modal.querySelector(".ci-modal-card")) return;
    const column = radio.closest(".flex.flex-col.gap-4") ?? radio.closest("div");
    if (!column) return;
    const card = h(
      "div",
      { class: "ci-modal-card" },
      icon("import", 18),
      h("div", { class: "ci-grow" }, h("strong", { text: "Import from links" }), h("div", { class: "ci-muted", text: "Paste Chub, JanitorAI, RisuRealm… links. Duplicates are skipped." })),
      h("button", {
        type: "button",
        class: "ci-btn ci-btn--primary",
        text: "Paste links",
        onClick: () => void ciImportUi.open(readImportOptions(modal)),
      }),
    );
    column.prepend(card);
  }

  function syncLauncher() {
    const nav = document.querySelector(NAV_SELECTOR);
    if (nav && launcher.parentElement !== nav) {
      const settings = nav.querySelector(SETTINGS_SELECTOR);
      if (settings) nav.insertBefore(launcher, settings);
      else nav.append(launcher);
    }
    // Only when the top bar is really gone for a moment, not during a re-render
    const navVisible = !!nav && nav.getClientRects().length > 0;
    clearTimeout(floatTimer);
    if (navVisible || !ciSettings.get().floatingButton) floating.remove();
    else floatTimer = setTimeout(() => {
      const again = document.querySelector(NAV_SELECTOR);
      if ((!again || !again.getClientRects().length) && !floating.isConnected) document.body.append(floating);
    }, 1500);
  }

  function sync() {
    frame = 0;
    try {
      syncLauncher();
      syncImportModal();
    } catch (error) {
      marinara.log.warn("Char Importer could not place its buttons", error);
    }
  }

  /** Small count on the launcher while the queue works. */
  function setBadge(text) {
    const badge = launcher.querySelector(".ci-badge");
    badge.hidden = !text;
    badge.textContent = text ?? "";
  }

  function start() {
    observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(sync);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(floatTimer);
    launcher.remove();
    floating.remove();
    for (const card of document.querySelectorAll(".ci-modal-card")) card.remove();
  }

  // ── Open a character's editor ──
  // Marinara has no extension API for this, so it goes through the Characters
  // panel: clicking a character's row there opens its editor.

  const PANEL_SELECTOR = '[data-component="CharactersPanelScroll"]';
  const rowFor = (id) => document.querySelector(`${PANEL_SELECTOR} [data-character-id="${CSS.escape(id)}"]`);

  async function waitFor(find, ms = 3000) {
    const until = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found || Date.now() > until) return found ?? null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function setReactInputValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** @returns {Promise<boolean>} whether the editor was opened */
  async function openCharacterEditor(id, name) {
    try {
      let row = rowFor(id);
      if (!row) {
        if (!document.querySelector(PANEL_SELECTOR)) document.querySelector('[data-component="TopBar"] [data-tour="panel-characters"], [data-tour="panel-characters"]')?.click();
        const panel = await waitFor(() => document.querySelector(PANEL_SELECTOR));
        const search = panel && (panel.querySelector('input[placeholder*="earch"]') ?? panel.querySelector('input:not([type="checkbox"])'));
        if (search && name) {
          const previous = search.value;
          setReactInputValue(search, name);
          row = await waitFor(() => rowFor(id));
          if (row) row.click();
          setReactInputValue(search, previous);
          if (row) return true;
        }
      }
      if (row) {
        row.click();
        return true;
      }
    } catch (error) {
      marinara.log.warn("Could not open the character editor", error);
    }
    ciDom.toast(`Couldn't open the editor automatically. Search for "${name}" in the Characters panel.`, "warn");
    return false;
  }

  return Object.freeze({ start, stop, setBadge, openCharacterEditor });
})();
