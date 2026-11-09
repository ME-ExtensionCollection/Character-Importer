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
  let watcherPoll = 0; // checks for the shutdown watcher while the queue is active
  let listEl = null; // the item list, kept between renders
  let listWrap = null; // the list plus the "follow current" button over it
  let followBtn = null;
  // Auto-scroll: follows the current link until the list is scrolled away from it
  let follow = true;
  let current = null; // the current link (running, else next waiting, else last)
  let anchor = null; // while not following: the link the drawn window is centred on
  let rows = new WeakMap(); // queue item -> { li, sig }
  let followed = null; // the current item last scrolled into view
  // Links drawn before and after the current one; each "show more" click adds a page
  const WINDOW = 50;
  const PAGE = 200;
  let before = WINDOW;
  let after = WINDOW;
  let more = {}; // the "show more" rows: { top, bottom } -> { li, text }

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
      h("button", { type: "button", class: "ci-icon-btn", title: collapsed ? "Expand" : "Collapse", onClick: () => ((collapsed = !collapsed), (followed = null), render()) }, icon(collapsed ? "chevronUp" : "chevronDown")),
      h("button", { type: "button", class: "ci-icon-btn", title: q.running ? "Hide (keeps importing)" : "Close", onClick: () => (q.running || q.paused ? hide() : ciQueue.clearFinished()) }, icon("x")),
    );

    const list = collapsed ? null : syncList(q.items);

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
    } else if ((q.running || q.paused) && (q.watcher || q.shutdown)) {
      // Only offered while tools/shutdown-watcher.mjs is running (its heartbeat), or once ticked
      shutdownRow = h(
        "div",
        { class: "ci-row ci-queue-shutdown" },
        checkbox("Turn off Marinara when done", q.shutdown, (v) => ciQueue.setShutdown(v),
          "When the queue finishes on its own (not when you stop it), waits 30 s, then asks the shutdown watcher script to stop Marinara. Only for this session."),
        q.shutdown && !q.watcher ? h("span", { class: "ci-warn", text: "The watcher has stopped." }) : null,
      );
    }
    // Look for the watcher while the queue is active
    const active = q.running || q.paused;
    if (active && !watcherPoll) {
      void ciQueue.checkWatcher();
      watcherPoll = setInterval(() => void ciQueue.checkWatcher(), 20_000);
    } else if (!active && watcherPoll && !counting) {
      clearInterval(watcherPoll);
      watcherPoll = 0;
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
    if (list?.parentNode === panel) {
      // The list is never moved (moving it loses its scroll position): swap the parts around it
      for (const child of [...panel.children]) if (child !== list) child.remove();
      list.before(head);
      list.after(...[shutdownRow, foot].filter(Boolean));
    } else {
      // replaceChildren turns null into the text "null"
      panel.replaceChildren(...[head, list, shutdownRow, foot].filter(Boolean));
    }
    // Scroll to the current link when it changes, while following
    if (list && follow && current && current !== followed) {
      followed = current;
      rows.get(current)?.li.scrollIntoView({ block: "nearest" });
    }
  }

  // Only a window around the current link is drawn: the rest of a long queue stays in the
  // queue's data and comes in a page at a time from the "earlier" / "more waiting" rows.
  // Items that are drawn keep their <li> between renders, rebuilt only when what it shows changes.
  function syncList(items) {
    if (!listWrap) {
      listEl = h("ol", { class: "ci-queue-list", onScroll: onListScroll });
      followBtn = h("button", { type: "button", class: "ci-icon-btn ci-queue-follow", title: "Follow the current link", "aria-label": "Follow the current link", onClick: resumeFollow }, icon("locate", 14));
      listWrap = h("div", { class: "ci-queue-listwrap" }, listEl, followBtn);
    }
    if (!items.length) {
      before = WINDOW;
      after = WINDOW;
      follow = true;
      anchor = null;
    }
    // The running link, else the next waiting one, else the end (all finished)
    let cur = items.findIndex((i) => i.state === "running");
    if (cur < 0) cur = items.findIndex((i) => i.state === "pending");
    if (cur < 0) cur = items.length;
    current = items[Math.min(cur, items.length - 1)] ?? null;
    // Not following: the window stays where it was, so rows don't slide away while reading
    let at = cur;
    if (!follow && anchor) {
      const i = items.indexOf(anchor);
      if (i >= 0) at = i;
    }
    followBtn.hidden = follow;
    const start = Math.max(0, at - before);
    const end = Math.min(items.length, at + 1 + after);

    const lis = [];
    if (start > 0) lis.push(moreRow("top", `Show ${Math.min(PAGE, start)} earlier (${start} hidden)`, () => loadMore("top")));
    for (let i = start; i < end; i++) {
      const item = items[i];
      const sig = `${item.state}\u0000${item.name || item.url}\u0000${item.note || ""}`;
      let row = rows.get(item);
      if (!row || row.sig !== sig) {
        const li = itemRow(item);
        row?.li.replaceWith(li);
        row = { li, sig };
        rows.set(item, row);
      }
      lis.push(row.li);
    }
    const later = items.length - end;
    if (later > 0) lis.push(moreRow("bottom", `${later} more waiting. Show ${Math.min(PAGE, later)}`, () => loadMore("bottom")));

    const kids = listEl.children;
    let same = kids.length === lis.length;
    for (let i = 0; same && i < lis.length; i++) same = kids[i] === lis[i];
    if (!same) listEl.replaceChildren(...lis);
    return listWrap;
  }

  function isShown(item) {
    const li = item && rows.get(item)?.li;
    if (!li?.isConnected) return false;
    const box = listEl.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  }

  function stopFollowing() {
    if (!follow) return;
    follow = false;
    anchor = current;
    schedule();
  }

  // Scrolling the current link out of view turns auto-scroll off
  let scrollCheck = 0;
  function onListScroll() {
    if (!follow || scrollCheck) return;
    scrollCheck = requestAnimationFrame(() => {
      scrollCheck = 0;
      if (follow && current && !isShown(current)) stopFollowing();
    });
  }

  // Back to the current link, and drop the extra rows loaded meanwhile
  function resumeFollow() {
    follow = true;
    anchor = null;
    before = WINDOW;
    after = WINDOW;
    followed = null;
    render();
  }

  // The "earlier" / "more waiting" rows, reused while their text stays the same
  function moreRow(key, text, onClick) {
    const old = more[key];
    if (old?.text === text) return old.li;
    const li = h("li", { class: "ci-queue-more" }, h("button", { type: "button", class: "ci-link-btn", text, onClick }));
    more[key] = { li, text };
    return li;
  }

  function loadMore(side) {
    stopFollowing();
    if (side === "top") {
      // Keep the view where it is while rows are added above it
      const height = listEl.scrollHeight;
      before += PAGE;
      render();
      listEl.scrollTop += listEl.scrollHeight - height;
    } else {
      after += PAGE;
      render();
    }
  }

  function itemRow(item) {
    return h(
      "li",
      { class: `ci-queue-item ci-state--${item.state}`, title: item.url },
      icon(ICONS[item.state] ?? "clock", 14, item.state === "running" ? "ci-spin" : ""),
      h("div", { class: "ci-queue-text" }, h("div", { class: "ci-queue-url", text: item.name || item.url }), item.note ? h("div", { class: "ci-queue-note", text: item.note }) : null),
    );
  }

  function dispose() {
    unsubscribe?.();
    unsubscribe = null;
    if (frame) cancelAnimationFrame(frame);
    clearInterval(tick);
    tick = 0;
    clearInterval(watcherPoll);
    watcherPoll = 0;
    panel?.remove();
    panel = null;
    rows = new WeakMap();
    more = {};
    followed = null;
    listWrap = listEl = followBtn = current = anchor = null;
    follow = true;
    if (scrollCheck) cancelAnimationFrame(scrollCheck);
    scrollCheck = 0;
  }

  return Object.freeze({ show, hide, ensure, render, dispose });
})();
