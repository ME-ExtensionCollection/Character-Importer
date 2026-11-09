// Char Importer: floating import queue panel (bottom left; Marinara docks
// sandboxed extension windows bottom right).

const ciQueueUi = (() => {
  "use strict";

  const { h, icon, button, checkbox, plural, toast } = ciDom;
  const ICONS = { pending: "clock", running: "loader", done: "check", warn: "alert", skipped: "skip", failed: "fail" };
  let panel = null;
  let hidden = true;
  let collapsed = false;
  let unsubscribe = null;
  let frame = 0;
  let tick = 0; // redraws the shutdown countdown every second

  function ensure() {
    if (panel?.isConnected) return panel;
    panel = h("section", { class: "ci-root ci-queue", "aria-label": "Character import queue" });
    document.body.append(panel);
    unsubscribe ??= ciQueue.subscribe(schedule);
    return panel;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function show() {
    hidden = false;
    ensure();
    render();
  }

  function hide() {
    hidden = true;
    render();
  }

  // Links that never ran: still waiting, or cut off by a stop or dismiss (the current one too, on Stop now)
  const isRemaining = (item) => item.state === "pending" || ((item.state === "skipped" || item.state === "failed") && (item.note === "Stopped" || item.note === "Dismissed"));

  async function copyRemaining(items) {
    const text = items.map((i) => i.url).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain http, or permission refused): the old way
      const area = h("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
      document.body.append(area);
      area.select();
      const ok = document.execCommand?.("copy");
      area.remove();
      if (!ok) {
        toast("Couldn't copy to the clipboard.", "error");
        return;
      }
    }
    toast(`Copied ${plural(items.length, "link")}. Paste them into the import box to carry on.`, "success");
  }

  function render() {
    frame = 0;
    const q = ciQueue.get();
    if (!panel) return;
    panel.hidden = hidden || (!q.items.length && !(q.shutdownAt > Date.now()));
    if (hidden) return;

    const counts = {};
    for (const item of q.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    const finished = q.items.length - (counts.pending ?? 0) - (counts.running ?? 0);
    const running = q.items.find((i) => i.state === "running");
    const title = q.running ? `Importing ${finished + 1} / ${q.items.length}` : q.paused ? "Import paused" : `Imported ${finished} / ${q.items.length}`;
    const subtitle = collapsed && running ? running.note || q.step : "";

    const head = h(
      "div",
      { class: "ci-queue-head" },
      h("div", { class: "ci-queue-title" }, h("strong", { text: title }), subtitle ? h("span", { class: "ci-muted", text: subtitle }) : null),
      h("button", { type: "button", class: "ci-icon-btn", title: collapsed ? "Expand" : "Collapse", onClick: () => ((collapsed = !collapsed), render()) }, icon(collapsed ? "chevronUp" : "chevronDown")),
      h("button", { type: "button", class: "ci-icon-btn", title: q.running ? "Hide (keeps importing)" : "Close", onClick: () => (q.running || q.paused ? hide() : ciQueue.clearFinished()) }, icon("x")),
    );

    const list = collapsed
      ? null
      : h(
          "ol",
          { class: "ci-queue-list" },
          q.items.map((item) =>
            h(
              "li",
              { class: `ci-queue-item ci-state--${item.state}`, title: item.url },
              icon(ICONS[item.state] ?? "clock", 14, item.state === "running" ? "ci-spin" : ""),
              h("div", { class: "ci-queue-text" }, h("div", { class: "ci-queue-url", text: item.name || item.url }), item.note ? h("div", { class: "ci-queue-note", text: item.note }) : null),
            ),
          ),
        );

    const summary = ["done", "warn", "skipped", "failed"]
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${{ done: "done", warn: "with warnings", skipped: "skipped", failed: "failed" }[s]}`)
      .join(" · ");
    const actions = [];
    // Turn off Marinara when done (this session only; tools/shutdown-watcher.mjs does the stopping)
    const counting = q.shutdownAt > Date.now();
    if (counting && !tick) tick = setInterval(schedule, 1000);
    if (!counting && tick) {
      clearInterval(tick);
      tick = 0;
    }
    let shutdownRow = null;
    if (counting) {
      shutdownRow = h(
        "div",
        { class: "ci-row ci-queue-shutdown" },
        h("strong", { class: "ci-grow", text: `Turning Marinara off in ${Math.ceil((q.shutdownAt - Date.now()) / 1000)} s` }),
        button("Cancel", () => ciQueue.cancelShutdown(), { kind: "primary" }),
      );
    } else if (q.shutdownSent) {
      shutdownRow = h("div", { class: "ci-row ci-queue-shutdown ci-muted", text: "Asked the shutdown watcher to turn Marinara off." });
    } else if (q.running || q.paused) {
      shutdownRow = h(
        "div",
        { class: "ci-row ci-queue-shutdown" },
        checkbox("Turn off Marinara when done", q.shutdown, (v) => ciQueue.setShutdown(v),
          "When the queue finishes on its own (not when you stop it), waits 30 s, then asks the shutdown watcher script to stop Marinara. Needs tools/shutdown-watcher.mjs running on the server's computer; see Tools → Companion userscript. Only for this session."),
      );
    }
    const remaining = q.running ? [] : q.items.filter(isRemaining);
    if (remaining.length) actions.push(button(`Copy ${remaining.length} remaining`, () => void copyRemaining(remaining), { title: "Copies the links that weren't imported, one per line" }));
    if (q.running) {
      actions.push(button(q.stop ? "Stopping…" : "Stop after this link", () => ciQueue.stopAfterCurrent(), { disabled: q.stop }));
      actions.push(button("Stop now", () => ciQueue.abort(), { kind: "danger" }));
    } else if (q.paused) {
      actions.push(h("span", { class: "ci-muted", text: `${plural(counts.pending ?? 0, "link")} left from last time` }));
      actions.push(button("Resume", () => ciQueue.resume(), { kind: "primary" }));
      actions.push(button("Dismiss", () => ciQueue.dismiss()));
    } else {
      actions.push(button("Clear", () => ciQueue.clearFinished()));
    }
    const foot = h("div", { class: "ci-queue-foot" }, summary ? h("span", { class: "ci-muted ci-grow", text: summary }) : h("span", { class: "ci-grow" }), actions);

    panel.classList.toggle("is-collapsed", collapsed);
    panel.replaceChildren(head, list, shutdownRow, foot);
    if (list && running) {
      const node = list.querySelector(".ci-state--running");
      node?.scrollIntoView({ block: "nearest" });
    }
  }

  function dispose() {
    unsubscribe?.();
    unsubscribe = null;
    if (frame) cancelAnimationFrame(frame);
    clearInterval(tick);
    tick = 0;
    panel?.remove();
    panel = null;
  }

  return Object.freeze({ show, hide, ensure, render, dispose });
})();
