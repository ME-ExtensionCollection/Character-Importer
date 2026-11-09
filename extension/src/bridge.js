// Char Importer: client for the companion userscript's download bridge.
// Marinara has no general CORS proxy, so sites that don't allow cross-origin
// reads are fetched by the userscript (GM_xmlhttpRequest) and handed back
// here over window CustomEvents. The detail is always a JSON string so it
// crosses the userscript sandbox boundary in every manager.

const ciBridge = (() => {
  "use strict";

  const PREFIX = "charimporter:bridge:";
  const V = 1;
  const pending = new Map();
  let info = null; // {name, version, maxBytes, hostPolicy, cookieSites} once the userscript answered
  let helloAt = 0;
  let readyWaiters = [];

  const send = (type, payload) =>
    window.dispatchEvent(new CustomEvent(PREFIX + type, { detail: JSON.stringify({ v: V, ...payload }) }));

  function parse(event) {
    try {
      const detail = typeof event.detail === "string" ? JSON.parse(event.detail) : null;
      return detail && detail.v === V ? detail : null;
    } catch {
      return null;
    }
  }

  function onReady(event) {
    const detail = parse(event);
    if (!detail) return;
    info = { name: String(detail.name ?? "userscript"), version: String(detail.version ?? "?"), maxBytes: Number(detail.maxBytes) || 32 * 1024 * 1024, hostPolicy: detail.hostPolicy ?? "public", cookieSites: Array.isArray(detail.cookieSites) ? detail.cookieSites.map(String) : [] };
    for (const resolve of readyWaiters) resolve(info);
    readyWaiters = [];
  }

  function onResponse(event) {
    const detail = parse(event);
    const entry = detail && pending.get(detail.id);
    if (!entry) return;
    pending.delete(detail.id);
    clearTimeout(entry.timer);
    entry.resolve(detail);
  }

  function onProgress(event) {
    const detail = parse(event);
    const entry = detail && pending.get(detail.id);
    entry?.onProgress?.(Number(detail.loaded) || 0, Number(detail.total) || 0);
  }

  window.addEventListener(PREFIX + "ready", onReady);
  window.addEventListener(PREFIX + "response", onResponse);
  window.addEventListener(PREFIX + "progress", onProgress);

  /** Asks whether the userscript is there. Resolves its info, or null after `wait` ms. */
  function detect(wait = 400) {
    if (info) return Promise.resolve(info);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((r) => r !== done);
        resolve(null);
      }, wait);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      readyWaiters.push(done);
      helloAt = Date.now();
      send("hello", {});
    });
  }

  const available = () => !!info;
  const getInfo = () => info;
  /** Whether the userscript can send cookies for this host (a newer companion). */
  const canSendCookies = (host) => !!info?.cookieSites.some((site) => host === site || host.endsWith(`.${site}`));

  class BridgeError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  /**
   * GET a URL through the userscript.
   * @param {string} url
   * `cookies` asks the userscript to send this browser's cookies for the site;
   * it only does that for sites it lists in cookieSites, after asking the user.
   * @param {{responseType?: "base64"|"text", accept?: string, timeoutMs?: number, maxBytes?: number, cookies?: boolean, signal?: AbortSignal, onProgress?: Function}} [options]
   * @returns {Promise<{status: number, ok: boolean, finalUrl: string, headers: Record<string,string>, bytes?: Uint8Array, text?: string}>}
   */
  async function fetchVia(url, options = {}) {
    if (!info && (Date.now() - helloAt > 10_000 || !helloAt)) await detect();
    if (!info) throw new BridgeError("absent", "The Char Importer companion userscript is not installed or not running on this page");
    const id = crypto.randomUUID();
    const timeoutMs = Math.min(options.timeoutMs ?? 60_000, 300_000);
    const maxBytes = Math.min(options.maxBytes ?? 32 * 1024 * 1024, info.maxBytes);
    const responseType = options.responseType ?? "base64";
    const detail = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        send("abort", { id });
        reject(new BridgeError("timeout", `No answer from the userscript in time for ${url}`));
      }, timeoutMs + 5000);
      pending.set(id, { resolve, timer, onProgress: options.onProgress });
      options.signal?.addEventListener(
        "abort",
        () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          send("abort", { id });
          reject(new BridgeError("aborted", "Download stopped"));
        },
        { once: true },
      );
      send("request", { id, url, method: "GET", accept: options.accept, responseType, timeoutMs, maxBytes, cookies: !!options.cookies });
    });
    if (detail.error) throw new BridgeError(detail.error.kind ?? "network", detail.error.message ?? `Userscript could not fetch ${url}`);
    const headers = {};
    for (const [k, v] of Object.entries(detail.headers ?? {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const out = { status: Number(detail.status) || 0, ok: !!detail.ok, finalUrl: String(detail.finalUrl ?? url), headers };
    if (typeof detail.bodyBase64 === "string") out.bytes = ciPng.base64ToBytes(detail.bodyBase64);
    if (typeof detail.bodyText === "string") out.text = detail.bodyText;
    return out;
  }

  function dispose() {
    window.removeEventListener(PREFIX + "ready", onReady);
    window.removeEventListener(PREFIX + "response", onResponse);
    window.removeEventListener(PREFIX + "progress", onProgress);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      send("abort", { id });
    }
    pending.clear();
  }

  return Object.freeze({ detect, available, getInfo, canSendCookies, fetch: fetchVia, BridgeError, dispose });
})();
