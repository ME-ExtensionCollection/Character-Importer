// Char Importer: downloads. Tries the cheapest way that works and remembers
// what failed: Marinara's own proxy routes for sites it knows, then a direct
// browser fetch, then the companion userscript. Hosts that fail several times
// in a row are skipped for a while (same rules as Dupe Link Skip).

const ciNet = (() => {
  "use strict";

  class RateLimitError extends Error {
    constructor(message, retryAfterMs = 60_000) {
      super(message);
      this.retryAfterMs = retryAfterMs;
    }
  }
  // Saving into Marinara failed, as opposed to the remote file being unavailable
  class LocalSaveError extends Error {}
  class TimeoutError extends Error {}
  class HostDownError extends Error {}
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  // Neither a direct fetch nor the userscript could reach the URL
  class BlockedError extends Error {}

  const HOST_FAILURE_LIMIT = 3;
  const HOST_DOWN_MS = 10 * 60 * 1000;
  const corsBlockedHosts = new Set();
  const hostFailures = new Map();
  const hostDownUntil = new Map();

  const hostOf = (url) => {
    try {
      return new URL(url, location.href).hostname.toLowerCase();
    } catch {
      return "";
    }
  };

  function isHostDown(url) {
    const until = hostDownUntil.get(hostOf(url));
    return !!until && until > Date.now();
  }
  const downHosts = () => [...hostDownUntil].filter(([, until]) => until > Date.now()).map(([host]) => host);

  function noteResult(url, ok) {
    const host = hostOf(url);
    if (!host) return;
    if (ok) {
      hostFailures.delete(host);
      hostDownUntil.delete(host);
      return;
    }
    const count = (hostFailures.get(host) ?? 0) + 1;
    hostFailures.set(host, count);
    if (count >= HOST_FAILURE_LIMIT) hostDownUntil.set(host, Date.now() + HOST_DOWN_MS);
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });

  function retryAfterMs(value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10 * 60_000);
    const date = Date.parse(value ?? "");
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 1000), 10 * 60_000);
    return 60_000;
  }

  /**
   * fetch() with a timeout for the headers and another for the body.
   * Same-origin paths go through marinara.fetch (traffic is attributed to the extension).
   * @returns {Promise<{status: number, ok: boolean, headers: Headers, bytes: Uint8Array, url: string}>}
   */
  async function fetchWithTimeout(url, init = {}, { headers = 15_000, body = 300_000, signal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => controller.abort(), headers);
    const sameOrigin = url.startsWith("/") || hostOf(url) === location.hostname;
    try {
      const response = await (sameOrigin ? marinara.fetch : fetch)(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), body);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, ok: response.ok, headers: response.headers, bytes, url: response.url || url };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new TimeoutError(`No response in time from ${hostOf(url) || url}`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function checkStatus(result, url) {
    if (result.status === 429) throw new RateLimitError(`Rate limited by ${hostOf(url)}`, retryAfterMs(result.headers.get?.("retry-after") ?? result.headers["retry-after"]));
    if (!result.ok) throw new HttpError(result.status, `${hostOf(url) || url} answered ${result.status}`);
  }

  /**
   * Downloads a remote URL: direct first, then the userscript bridge.
   * @param {string} url absolute http(s) URL
   * `siteLogin` goes straight to the userscript, which adds your login for
   * the site (only sites the userscript allows it for).
   * @param {{accept?: string, signal?: AbortSignal, maxBytes?: number, timeoutMs?: number, onProgress?: Function, noBridge?: boolean, siteLogin?: boolean}} [options]
   * @returns {Promise<{bytes: Uint8Array, contentType: string, finalUrl: string, via: "direct"|"bridge"}>}
   */
  async function fetchRemote(url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`);
    if (isHostDown(url)) throw new HostDownError(`${hostOf(url)} failed several times; skipped for a while`);
    const host = hostOf(url);
    let directError = null;

    if (!corsBlockedHosts.has(host) && !options.siteLogin) {
      try {
        const result = await fetchWithTimeout(url, { headers: options.accept ? { Accept: options.accept } : undefined, credentials: "omit" }, {
          headers: options.timeoutMs ?? 15_000,
          signal: options.signal,
        });
        checkStatus(result, url);
        noteResult(url, true);
        return { bytes: result.bytes, contentType: result.headers.get("content-type") ?? "", finalUrl: result.url, via: "direct" };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof TypeError) {
          // CORS or network failure. CORS can't be told apart from here, so try the userscript.
          corsBlockedHosts.add(host);
          directError = error;
        } else if (error instanceof TimeoutError) {
          noteResult(url, false);
          throw error;
        } else {
          throw error;
        }
      }
    }

    if (options.noBridge) throw new BlockedError(`${host} does not allow downloads from this page${directError ? "" : " (blocked before)"}`);
    try {
      const result = await ciBridge.fetch(url, {
        accept: options.accept,
        signal: options.signal,
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs ? options.timeoutMs + 60_000 : 120_000,
        onProgress: options.onProgress,
        siteLogin: options.siteLogin,
      });
      const headers = { get: (name) => result.headers[name.toLowerCase()] ?? null };
      checkStatus({ ...result, headers }, url);
      noteResult(url, true);
      return { bytes: result.bytes ?? new TextEncoder().encode(result.text ?? ""), contentType: result.headers["content-type"] ?? "", finalUrl: result.finalUrl, via: "bridge" };
    } catch (error) {
      if (error instanceof ciBridge.BridgeError) {
        if (error.kind === "absent") throw new BlockedError(`${host} blocks downloads from this page. Install the Char Importer companion userscript to fetch it.`);
        if (error.kind === "timeout" || error.kind === "network") noteResult(url, false);
        if (error.kind === "timeout") throw new TimeoutError(error.message);
        if (error.kind === "aborted") throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }
  }

  async function fetchRemoteJson(url, options = {}) {
    const { bytes } = await fetchRemote(url, { accept: "application/json", ...options });
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** GET a Marinara path (proxy routes). Returns bytes and type; throws HttpError/RateLimitError. */
  async function fetchLocal(path, { signal, timeoutMs = 90_000 } = {}) {
    const result = await fetchWithTimeout(path, {}, { headers: timeoutMs, signal });
    if (!result.ok) {
      let message = "";
      try {
        message = JSON.parse(new TextDecoder().decode(result.bytes))?.error ?? "";
      } catch {
        // not JSON
      }
      if (result.status === 429) throw new RateLimitError(message || "Marinara rate limit", retryAfterMs(result.headers.get("retry-after")));
      throw new HttpError(result.status, message || `${path.split("?")[0]} answered ${result.status}`);
    }
    return { bytes: result.bytes, contentType: result.headers.get("content-type") ?? "" };
  }

  async function fetchLocalJson(path, options) {
    const { bytes } = await fetchLocal(path, options);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function describe(error) {
    if (!error) return "Unknown error";
    if (error.name === "AbortError") return "Stopped";
    return error.message || String(error);
  }

  return Object.freeze({
    RateLimitError, LocalSaveError, TimeoutError, HostDownError, HttpError, BlockedError,
    hostOf, isHostDown, downHosts, noteResult, sleep,
    fetchWithTimeout, fetchRemote, fetchRemoteJson, fetchLocal, fetchLocalJson, describe,
  });
})();
