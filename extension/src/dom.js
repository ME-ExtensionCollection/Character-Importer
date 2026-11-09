// Char Importer: DOM helpers. Plain DOM; text from cards and websites always
// goes in through textContent or input.value, never as HTML.

const ciDom = (() => {
  "use strict";

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") Object.assign(node.style, value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node && key !== "list") node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // Lucide icons (ISC license)
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    link: [["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }], ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }]],
    import: [["path", { d: "M12 3v12" }], ["path", { d: "m8 11 4 4 4-4" }], ["path", { d: "M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4" }]],
    x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
    refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
    pencil: [["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }], ["path", { d: "m15 5 4 4" }]],
    edit: [["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }], ["path", { d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" }]],
    trash: [["path", { d: "M3 6h18" }], ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }], ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }]],
    chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
    chevronUp: [["path", { d: "m18 15-6-6-6 6" }]],
    clock: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 6v6l4 2" }]],
    loader: [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }]],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
    alert: [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
    skip: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m4.9 4.9 14.2 14.2" }]],
    fail: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m15 9-6 6" }], ["path", { d: "m9 9 6 6" }]],
    settings: [["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
    locate: [["path", { d: "M2 12h3" }], ["path", { d: "M19 12h3" }], ["path", { d: "M12 2v3" }], ["path", { d: "M12 19v3" }], ["circle", { cx: "12", cy: "12", r: "7" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
    download: [["path", { d: "M12 15V3" }], ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "m7 10 5 5 5-5" }]],
  };

  function icon(name, size = 16, extraClass = "") {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(k, String(v));
    }
    if (extraClass) svg.setAttribute("class", extraClass);
    for (const [tag, attrs] of ICONS[name] ?? []) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
      svg.append(child);
    }
    return svg;
  }

  function button(label, onClick, { kind = "", title, disabled, iconName } = {}) {
    const mods = kind.split(" ").filter(Boolean).map((k) => ` ci-btn--${k}`).join("");
    return h("button", { type: "button", class: `ci-btn${mods}`, title, disabled, onClick }, iconName ? icon(iconName, 14) : null, label);
  }

  function checkbox(label, checked, onChange, title) {
    return h(
      "label",
      { class: "ci-check", title },
      h("input", { type: "checkbox", checked, onChange: (e) => onChange?.(e.currentTarget.checked) }),
      h("span", { text: label }),
    );
  }

  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

  function ago(time) {
    if (!time) return "never";
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(time).toLocaleDateString();
  }

  // ── Toasts ──

  let toastHost = null;
  function toast(text, kind = "info") {
    if (!toastHost?.isConnected) {
      toastHost = h("div", { class: "ci-toasts", "aria-live": "polite" });
      document.body.append(toastHost);
    }
    const node = h("div", { class: `ci-toast ci-toast--${kind}`, role: "status", text });
    toastHost.append(node);
    setTimeout(() => node.remove(), kind === "error" ? 9000 : 5000);
  }

  // ── Dialogs ──

  const open = new Set();

  // Escape closes the topmost dialog, wherever focus is
  function onEscape(e) {
    if (e.key !== "Escape" || !open.size) return;
    const top = [...open].at(-1);
    e.stopPropagation();
    e.preventDefault();
    if (top.closable && !top.isBusy()) top.close(null);
  }
  document.addEventListener("keydown", onEscape, true);

  /**
   * Modal dialog. Returns {body, setBody, setActions, setBusy, close, result}.
   * @param {{title: string, body?: any[], wide?: boolean, closable?: boolean, onClose?: Function}} options
   */
  function dialog({ title, body = [], wide = false, closable = true, onClose }) {
    let resolve;
    const result = new Promise((r) => (resolve = r));
    let busy = false;
    const bodyEl = h("div", { class: "ci-dialog-body" }, body);
    const actionsEl = h("div", { class: "ci-dialog-actions" });
    const closeBtn = h("button", { type: "button", class: "ci-icon-btn", title: "Close", "aria-label": "Close", onClick: () => handle.close(null) }, icon("x"));
    const box = h(
      "div",
      { class: `ci-dialog${wide ? " ci-dialog--wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "ci-dialog-head" }, h("h3", { text: title }), closable ? closeBtn : null),
      bodyEl,
      actionsEl,
    );
    const overlay = h("div", {
      class: "ci-root ci-overlay",
      onPointerdown: (e) => {
        if (e.target === overlay && closable && !busy) handle.close(null);
      },
      // Keys typed in our dialogs aren't Marinara shortcuts
      onKeydown: (e) => {
        if (e.key !== "Escape") e.stopPropagation();
      },
    }, box);
    const handle = {
      closable,
      isBusy: () => busy,
      body: bodyEl,
      setBody: (...nodes) => bodyEl.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
      setActions(actions) {
        actionsEl.replaceChildren(
          ...actions.map((a) =>
            a instanceof Node ? a : button(a.label, () => (a.onClick ? a.onClick() : handle.close(a.value)), { kind: a.kind, disabled: a.disabled, title: a.title }),
          ),
        );
      },
      setBusy(value) {
        busy = value;
        closeBtn.disabled = value;
        for (const b of actionsEl.querySelectorAll("button")) b.disabled = value || b.dataset.disabled === "1";
      },
      close(value = null) {
        if (!overlay.isConnected) return;
        overlay.remove();
        open.delete(handle);
        onClose?.(value);
        resolve(value);
      },
      result,
    };
    open.add(handle);
    document.body.append(overlay);
    requestAnimationFrame(() => (box.querySelector("textarea, input:not([type=checkbox]), button.ci-btn--primary") ?? box).focus?.());
    return handle;
  }

  async function confirm(title, body, okLabel = "OK", { kind = "primary", wide = false } = {}) {
    const d = dialog({ title, body: Array.isArray(body) ? body : [h("p", { text: body })], wide });
    d.setActions([
      { label: "Cancel", value: false },
      { label: okLabel, value: true, kind },
    ]);
    return (await d.result) === true;
  }

  function closeAll() {
    document.removeEventListener("keydown", onEscape, true);
    for (const d of [...open]) d.close(null);
    toastHost?.remove();
    toastHost = null;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: filename, style: { display: "none" } });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return Object.freeze({ h, append, icon, button, checkbox, plural, ago, toast, dialog, confirm, closeAll, downloadBlob });
})();
