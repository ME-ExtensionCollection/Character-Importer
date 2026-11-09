// ==UserScript==
// @name        Char Importer companion
// @namespace   ME-Extensions-CharImporter
// @match       *://127.0.0.1:7860/*
// @match       *://localhost:7860/*
// @match       *://192.168.1.50:7860/*
// @match       *://127.0.0.1:8000/*
// @match       *://localhost:8000/*
// @match       https://*.chub.ai/*
// @match       https://chub.ai/*
// @match       https://*.characterhub.org/*
// @match       https://characterhub.org/*
// @match       https://botbooru.com/*
// @match       https://www.botbooru.com/*
// @version     2.8
// @author      Rojikku
// @description Hides Chub cards already in your Marinara Engine or SillyTavern library, and downloads files for the Char Importer extension from sites that block downloads from the Marinara page.
// @run-at      document-idle
// @noframes
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @grant       GM_registerMenuCommand
// @connect     *
// ==/UserScript==

/*
 * Replaces the Dupe Link Skip Chub userscript (same events, so the
 * SillyTavern extension keeps working with it).
 *
 * On your Marinara / SillyTavern page:
 *   - stores the list of Chub characters the extension publishes
 *     (one list per app address; Chub hides cards from all of them)
 *   - Marinara only: answers download requests from the Char Importer
 *     extension with GM_xmlhttpRequest, which isn't limited by CORS.
 *     Requests are GET only, to public addresses only, and without
 *     cookies. The one exception: a few read-only Botbooru addresses
 *     (character pages, card downloads, creators' card lists, the login
 *     check) carry your Botbooru login, for galleries, full creator
 *     lists, and so Botbooru knows which cards you downloaded. You're asked before either is first used.
 * On Botbooru: keeps a copy of your Botbooru login (Botbooru keeps it in
 *   the page's localStorage, not in a cookie), unless you said no to using it.
 * On Chub and Botbooru: hides (or greys out) cards you already own.
 *
 * If Marinara or SillyTavern runs on another address or port, add it as
 * another @match line above (e.g. *://192.168.1.10:7860/*; the *:// covers
 * both http and https).
 */

(function () {
  "use strict";

  const isChub = /(^|\.)(chub\.ai|characterhub\.org)$/.test(location.hostname);
  const isBotbooru = /(^|\.)botbooru\.com$/.test(location.hostname);
  const STALE_DAYS = 7;
  const SCRIPT = { name: "Char Importer companion", version: "2.8" };

  // ── Owned lists, one per app origin ──

  function ownedLists() {
    const origins = GM_getValue("ownedOrigins", []);
    const lists = origins.map((origin) => ({ origin, ...(GM_getValue(`owned:${origin}`, null) ?? {}) })).filter((l) => Array.isArray(l.paths));
    // Written by the old Dupe Link Skip userscript
    const legacy = GM_getValue("owned", null);
    if (legacy?.paths && !origins.length) lists.push({ origin: "SillyTavern", app: "sillytavern", ...legacy });
    return lists;
  }

  function storeOwned(detail, origin = location.origin) {
    const { paths, botbooru, updated, app } = detail;
    if (!Array.isArray(paths)) throw new Error("no paths");
    const value = { paths: paths.map((p) => String(p).toLowerCase()), updated: Number(updated) || Date.now(), app: app ?? "sillytavern" };
    // Botbooru post IDs, sent by Char Importer only
    if (Array.isArray(botbooru)) value.botbooru = botbooru.map(String);
    GM_setValue(`owned:${origin}`, value);
    const origins = GM_getValue("ownedOrigins", []);
    if (!origins.includes(origin)) GM_setValue("ownedOrigins", [...origins, origin]);
    console.info(`[${SCRIPT.name}] Stored ${paths.length} owned Chub cards for ${origin}`);
  }

  // ── Sync from a Marinara server (for a browser without Marinara open) ──

  const SYNC_EVERY_MS = 30 * 1000;

  /** Fetches the owned list the extension saved on the server. Resolves its card count. */
  function syncOwned() {
    const raw = GM_getValue("syncUrl", "");
    if (!raw) return Promise.reject(new Error("No sync address set"));
    const url = new URL(raw);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url.href,
        anonymous: false, // sends the Marinara login cookie, if this browser has one
        timeout: 15000,
        responseType: "text",
        headers: { Accept: "application/json" },
        onload: (res) => {
          try {
            if (res.status === 401 || res.status === 403) throw new Error(`Marinara refused (${res.status}); sign in to Marinara in this browser, or use 127.0.0.1 if it runs on this computer`);
            if (res.status === 404) throw new Error("Not found (404); copy the address again from Char Importer's Tools");
            if (res.status < 200 || res.status >= 300) throw new Error(`Marinara answered ${res.status}`);
            const owned = JSON.parse(res.responseText)?.value?.ownedChub;
            if (!owned || !Array.isArray(owned.paths)) throw new Error("No owned list saved yet; open Marinara once with Char Importer enabled");
            // Stamped with the sync time: the server copy is current whenever it can be fetched
            storeOwned({ paths: owned.paths, botbooru: owned.botbooru, updated: Date.now(), app: "marinara" }, url.origin);
            GM_setValue("syncState", { at: Date.now(), error: null });
            resolve(owned.paths.length);
          } catch (error) {
            reject(error);
          }
        },
        onerror: (res) => reject(new Error(res?.error || `Could not reach ${url.host} (if it uses a self-signed certificate, open the address once in this browser)`)),
        ontimeout: () => reject(new Error(`No answer from ${url.host}`)),
      });
    }).catch((error) => {
      GM_setValue("syncState", { at: Date.now(), error: String(error?.message ?? error) });
      throw error;
    });
  }

  GM_registerMenuCommand?.("Char Importer: set Marinara sync address", () => {
    const current = GM_getValue("syncUrl", "");
    const input = window.prompt("Sync address from Char Importer → Tools → Companion userscript (empty to turn sync off):", current);
    if (input === null) return;
    const value = input.trim();
    if (!value) {
      GM_setValue("syncUrl", "");
      alert("Sync turned off.");
      return;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      alert("That isn't a valid address.");
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      alert("Only http and https addresses.");
      return;
    }
    GM_setValue("syncUrl", url.href);
    syncOwned().then(
      (count) => alert(`Synced ${count} owned Chub cards. Reload Chub pages to apply.`),
      (error) => alert(`Saved, but sync failed: ${error.message}`),
    );
  });
  GM_registerMenuCommand?.("Char Importer: sync owned list now", () => {
    syncOwned().then(
      (count) => alert(`Synced ${count} owned Chub cards. Reload Chub pages to apply.`),
      (error) => alert(`Sync failed: ${error.message}`),
    );
  });

  // ── Site logins kept in localStorage (Botbooru) ──

  // Botbooru signs requests with a bearer token from localStorage, so the
  // userscript copies it from botbooru.com pages and forgets it when you log
  // out. It's copied before you're asked (so the first import already has
  // it) but only sent once you've allowed it; saying no deletes it.
  function captureBotbooruLogin() {
    const check = () => {
      const tokens = GM_getValue("siteTokens", {});
      if (GM_getValue("loginConsent", {})["botbooru.com"] === false) {
        if (tokens["botbooru.com"]) {
          delete tokens["botbooru.com"];
          GM_setValue("siteTokens", tokens);
        }
        return;
      }
      let token = null;
      try {
        token = localStorage.getItem("token");
      } catch {
        return;
      }
      if (token && tokens["botbooru.com"] !== token) GM_setValue("siteTokens", { ...tokens, "botbooru.com": token });
      else if (!token && tokens["botbooru.com"]) {
        delete tokens["botbooru.com"];
        GM_setValue("siteTokens", tokens);
      }
    };
    check();
    window.addEventListener("storage", check);
    setInterval(check, 3000); // logging in or out on this page doesn't fire "storage"
  }

  GM_registerMenuCommand?.("Char Importer: forget site logins", () => {
    GM_setValue("loginConsent", {});
    GM_setValue("siteTokens", {});
    alert("Site logins (such as Botbooru) forgotten. You'll be asked again before one is used.");
  });

  if (isBotbooru) {
    captureBotbooruLogin();
    hideOwned(botbooruSite());
    return;
  }

  if (!isChub) {
    window.addEventListener("dupelinkskip:owned", (event) => {
      try {
        storeOwned(JSON.parse(event.detail));
      } catch (error) {
        console.error(`[${SCRIPT.name}] Bad owned list`, error);
      }
    });
    // Ask in case the extension published before this script loaded
    window.dispatchEvent(new CustomEvent("dupelinkskip:request"));
    startBridge();
    return;
  }

  hideOwned(chubSite());

  // ── Download bridge (Marinara page) ──

  function startBridge() {
    const PREFIX = "charimporter:bridge:";
    const V = 1;
    const MAX_BYTES = 64 * 1024 * 1024;
    const CONCURRENCY = 4;
    const RATE_PER_MIN = 120;
    // "known hosts only" policy
    const KNOWN_HOSTS = [
      "chub.ai", "characterhub.org", "charhub.io", "catbox.moe", "imgur.com", "imgbox.com", "discordapp.com", "discordapp.net",
      "githubusercontent.com", "github.com", "risuai.net", "risuai.xyz", "janitorai.com", "jannyai.com", "aicharactercards.com",
      "pixeldrain.com", "files.sillie.st", "postimg.cc", "ibb.co", "pomf2.lain.la", "litter.catbox.moe", "botbooru.com",
    ];
    // Sites whose requests may carry your login for them, and the only addresses (path and query) that may: read-only
    const LOGIN_SITES = {
      "botbooru.com": [
        /^\/post\/\d+$/, // a character page (gallery list)
        /^\/download\/png\/\d+$/, // a card download, so Botbooru counts it for your account
        /^\/auth\/me$/, // is the login still valid
        /^\/api\/users\/\d+\?upload_limit=\d{1,3}&upload_offset=\d{1,6}&upload_sort=latest$/, // a creator's card list
      ],
    };
    const active = new Map();
    const waiting = [];
    let recent = [];

    const send = (type, payload) => window.dispatchEvent(new CustomEvent(PREFIX + type, { detail: JSON.stringify({ v: V, ...payload }) }));
    const policy = () => GM_getValue("hostPolicy", "public");

    function ready() {
      send("ready", { name: SCRIPT.name, version: SCRIPT.version, maxBytes: MAX_BYTES, hostPolicy: policy(), loginSites: Object.keys(LOGIN_SITES) });
    }

    function isPrivateHost(host) {
      host = host.toLowerCase().replace(/^\[|\]$/g, "");
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
      if (!host.includes(".") && !host.includes(":")) return true; // single-label intranet names
      const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
      }
      if (/^\d+$/.test(host) || /^0x/i.test(host)) return true; // integer / hex IPv4 spellings
      if (host.includes(":")) {
        return host === "::" || host === "::1" || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || host.startsWith("::ffff:");
      }
      return false;
    }

    function checkUrl(raw) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        return { kind: "bad-url", message: "Not a valid address" };
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "bad-url", message: "Only http and https addresses" };
      if (url.username || url.password) return { kind: "bad-url", message: "Addresses with credentials are refused" };
      if (isPrivateHost(url.hostname)) return { kind: "blocked-host", message: `${url.hostname} is a local or private address` };
      if (policy() === "known") {
        const host = url.hostname.toLowerCase();
        if (!KNOWN_HOSTS.some((k) => host === k || host.endsWith(`.${k}`))) return { kind: "blocked-host", message: `${host} isn't on the userscript's known sites list` };
      }
      return null;
    }

    function trusted() {
      const trust = GM_getValue("trustedOrigins", {});
      if (trust[location.origin] === true) return true;
      if (trust[location.origin] === false) return false;
      const ok = window.confirm(
        `${SCRIPT.name}\n\nAllow ${location.origin} to download files from other websites through this userscript?\n\n` +
          "Only for the Char Importer extension. Downloads are read-only, without your cookies or logins (unless you allow a site separately), and never from local network addresses.",
      );
      GM_setValue("trustedOrigins", { ...trust, [location.origin]: ok });
      return ok;
    }

    /** The Authorization header for a login request, or why it can't be sent. */
    function loginHeaders(raw) {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const site = Object.keys(LOGIN_SITES).find((s) => host === s || host.endsWith(`.${s}`));
      if (!site || !LOGIN_SITES[site].some((re) => re.test(url.pathname + url.search))) return { error: { kind: "bad-url", message: `Your login isn't sent to ${host}${url.pathname}` } };
      const consent = GM_getValue("loginConsent", {});
      if (consent[site] === undefined) {
        consent[site] = window.confirm(
          `${SCRIPT.name}\n\nLet Char Importer use your ${site} login?\n\n` +
            `Needed for things ${site} only shows to logged-in users, such as a card's gallery. The userscript copies your login ` +
            `when you open ${site} in this browser, and would send it only with read-only requests: character pages, card downloads (so ` +
            `${site} counts them for you), creators' card lists and the login check. ` +
            "Other downloads still go without it. Change it from the userscript menu.",
        );
        GM_setValue("loginConsent", consent);
        if (!consent[site]) {
          const tokens = GM_getValue("siteTokens", {});
          delete tokens[site];
          GM_setValue("siteTokens", tokens);
        }
      }
      if (!consent[site]) return { error: { kind: "login-refused", message: `You chose not to let Char Importer use your ${site} login (change it from the userscript menu)` } };
      const token = GM_getValue("siteTokens", {})[site];
      if (!token) return { error: { kind: "no-login", message: `No ${site} login yet: open ${site} in this browser while logged in` } };
      return { headers: { Authorization: `Bearer ${token}` } };
    }

    function respond(id, payload) {
      active.delete(id);
      send("response", { id, ...payload });
      pump();
    }

    function headerMap(raw) {
      const out = {};
      for (const line of String(raw ?? "").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().toLowerCase();
        if (["content-type", "content-disposition", "content-length", "retry-after", "x-botbooru-pace"].includes(name)) out[name] = line.slice(i + 1).trim();
      }
      return out;
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function start(req) {
      const maxBytes = Math.min(Number(req.maxBytes) || MAX_BYTES, MAX_BYTES);
      const timeout = Math.min(Number(req.timeoutMs) || 60000, 300000);
      let done = false;
      const fail = (kind, message) => {
        if (done) return;
        done = true;
        respond(req.id, { ok: false, status: 0, error: { kind, message } });
      };
      const handle = GM_xmlhttpRequest({
        method: "GET",
        url: req.url,
        anonymous: true,
        timeout,
        responseType: req.responseType === "text" ? "text" : "blob",
        headers: { ...(req.accept ? { Accept: String(req.accept).slice(0, 200) } : {}), ...(req.loginHeaders ?? {}) },
        onprogress: (e) => {
          if (done) return;
          if (e.loaded > maxBytes) {
            handle?.abort?.();
            fail("too-large", `Larger than ${Math.round(maxBytes / 1048576)} MB`);
            return;
          }
          send("progress", { id: req.id, loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
        },
        onload: async (res) => {
          if (done) return;
          try {
            const finalUrl = res.finalUrl || req.url;
            const redirected = checkUrl(finalUrl);
            if (redirected) return fail(redirected.kind, `Redirected: ${redirected.message}`);
            const payload = { ok: res.status >= 200 && res.status < 300, status: res.status, statusText: res.statusText ?? "", finalUrl, headers: headerMap(res.responseHeaders) };
            if (req.responseType === "text") {
              if ((res.responseText ?? "").length > maxBytes) return fail("too-large", "Response too large");
              payload.bodyText = res.responseText ?? "";
            } else {
              const blob = res.response;
              if (blob && blob.size > maxBytes) return fail("too-large", "Response too large");
              payload.bodyBase64 = blob ? await blobToBase64(blob) : "";
            }
            done = true;
            respond(req.id, payload);
          } catch (error) {
            fail("network", String(error?.message ?? error));
          }
        },
        onerror: (res) => fail("network", res?.error || `Could not reach ${new URL(req.url).hostname}`),
        ontimeout: () => fail("timeout", "No answer in time"),
        onabort: () => fail("aborted", "Stopped"),
      });
      active.set(req.id, { abort: () => handle?.abort?.(), fail });
    }

    function pump() {
      while (active.size < CONCURRENCY && waiting.length) start(waiting.shift());
    }

    window.addEventListener(PREFIX + "hello", () => ready());

    window.addEventListener(PREFIX + "request", (event) => {
      let req;
      try {
        req = JSON.parse(event.detail);
      } catch {
        return;
      }
      if (!req || req.v !== V || typeof req.id !== "string" || typeof req.url !== "string") return;
      const reply = (kind, message) => send("response", { id: req.id, ok: false, status: 0, error: { kind, message } });
      if (req.method && req.method !== "GET") return reply("bad-url", "Only GET requests");
      const bad = checkUrl(req.url);
      if (bad) return reply(bad.kind, bad.message);
      if (!trusted()) return reply("untrusted-origin", `${location.origin} isn't allowed to use the userscript (change it from the userscript menu)`);
      req.loginHeaders = null;
      if (req.siteLogin === true) {
        const login = loginHeaders(req.url);
        if (login.error) return reply(login.error.kind, login.error.message);
        req.loginHeaders = login.headers;
      }
      const now = Date.now();
      recent = recent.filter((t) => now - t < 60000);
      if (recent.length >= RATE_PER_MIN) return reply("busy", "Too many downloads; try again in a minute");
      recent.push(now);
      waiting.push(req);
      pump();
    });

    window.addEventListener(PREFIX + "abort", (event) => {
      try {
        const { id } = JSON.parse(event.detail);
        const i = waiting.findIndex((r) => r.id === id);
        if (i >= 0) waiting.splice(i, 1);
        active.get(id)?.abort();
      } catch {
        // ignore
      }
    });

    GM_registerMenuCommand?.("Char Importer: forget allowed pages", () => {
      GM_setValue("trustedOrigins", {});
      alert("Pages will be asked again before downloading through this userscript.");
    });
    GM_registerMenuCommand?.(`Char Importer: downloads from ${policy() === "known" ? "any public site" : "known sites only"}`, () => {
      GM_setValue("hostPolicy", policy() === "known" ? "public" : "known");
      alert(`Downloads are now allowed from ${policy() === "known" ? "known card and image sites only" : "any public site"}. Reload the page to update this menu.`);
      ready();
    });

    ready();
  }

  // ── Hide owned cards (Chub, Botbooru) ──

  function chubSite() {
    const isLegacy = location.hostname.includes("characterhub.org");
    const LIST_SELECTOR = isLegacy ? "div.listings-container" : "#chara-list, .character-list-container";
    function pathFromHref(href) {
      if (!href) return null;
      const match = href.split(/[?#]/)[0].match(/\/characters\/([^/]+\/[^/]+)/);
      if (!match) return null;
      try {
        return decodeURIComponent(match[1]).toLowerCase();
      } catch {
        return match[1].toLowerCase();
      }
    }
    const cardLink = (card) => (isLegacy ? card.querySelector(".chub-card-info > div a") : card.closest("a[href]"));
    return {
      toggleKey: "showOwned",
      ownedOf: (list) => list.paths.map((p) => String(p).toLowerCase()),
      hasList: (list) => Array.isArray(list.paths),
      noListText: "No owned list yet. Open Marinara or SillyTavern once to send it.",
      // Extra banners whose changes don't add or remove cards (ChubDeslop's)
      otherBanners: ".chubfix-unhide-banner",
      containers: () => Array.from(document.querySelectorAll(LIST_SELECTOR)),
      cards: () =>
        Array.from(document.querySelectorAll(LIST_SELECTOR))
          .flatMap((list) => (isLegacy ? Array.from(list.querySelectorAll(":scope div:has(>.chub-card-info)")) : Array.from(list.querySelectorAll("div.ant-card"))))
          .map((card) => ({ el: isLegacy ? card : card.parentElement, id: pathFromHref(cardLink(card)?.getAttribute("href")) })),
      pageId: () => pathFromHref(location.pathname),
      placeBanner(banner, containers) {
        const target = containers.at(-1)?.parentElement;
        if (!target) return false;
        if (banner.parentElement !== target) target.prepend(banner);
        return true;
      },
    };
  }

  function botbooruSite() {
    // Grid cards are <a href="/character/<id>" data-post-id>; buttons inside carry data-post-id on a <span>,
    // and wiki mini cards have no data-post-id, so neither matches
    const CARD = 'a[href^="/character/"][data-post-id]';
    const cardEl = (a) => (a.parentElement && a.parentElement.children.length === 1 && !a.parentElement.matches("#gallery") ? a.parentElement : a);
    return {
      toggleKey: "showOwnedBotbooru",
      ownedOf: (list) => (Array.isArray(list.botbooru) ? list.botbooru.map(String) : []),
      hasList: (list) => Array.isArray(list.botbooru),
      noListText: "No owned Botbooru list yet. Open Marinara once to send it.",
      otherBanners: "",
      containers: () => [...new Set(Array.from(document.querySelectorAll(CARD)).map((a) => cardEl(a).parentElement).filter(Boolean))],
      cards: () => Array.from(document.querySelectorAll(CARD)).map((a) => ({ el: cardEl(a), id: a.getAttribute("data-post-id") })),
      pageId: () => location.pathname.match(/^\/character\/(\d+)/)?.[1] ?? null,
      placeBanner(banner, containers) {
        const grid = containers[0];
        if (!grid) return false;
        if (banner.nextElementSibling !== grid) grid.before(banner);
        return true;
      },
    };
  }

  function hideOwned(site) {
    let showOwned = GM_getValue(site.toggleKey, false);

    let lists, owned, newest, appNames;
    function loadLists() {
      lists = ownedLists().filter(site.hasList);
      owned = new Set(lists.flatMap(site.ownedOf));
      newest = lists.reduce((max, l) => Math.max(max, Number(l.updated) || 0), 0);
      appNames = [...new Set(lists.map((l) => (l.app === "marinara" ? "Marinara" : "SillyTavern")))].join(" / ") || "Marinara or SillyTavern";
    }
    loadLists();
    const syncError = () => (GM_getValue("syncUrl", "") ? GM_getValue("syncState", null)?.error : null);

    if (GM_getValue("syncUrl", "") && Date.now() - (GM_getValue("syncState", null)?.at ?? 0) > SYNC_EVERY_MS) {
      syncOwned().then(
        () => {
          loadLists();
          render();
        },
        (error) => {
          console.warn(`[${SCRIPT.name}] Sync failed`, error);
          render();
        },
      );
    }

    const style = document.createElement("style");
    style.textContent = `
      .dls-owned-hidden { display: none !important; }
      .dls-owned-shown { filter: saturate(0); opacity: 0.4; position: relative; }
      .dls-owned-shown:hover { filter: none; opacity: 1; }
      .dls-owned-shown::after {
        content: 'Owned'; position: absolute; top: 6px; left: 6px; z-index: 5;
        background: #2b7a3d; color: #fff; font-size: 12px; font-weight: bold;
        padding: 1px 6px; border-radius: 4px; pointer-events: none;
      }
      /* Same footprint as ChubDeslop's banner, in green */
      .dls-banner {
        display: flex; justify-content: center; align-items: center; text-align: center;
        padding: 2px; width: 25%; min-width: 220px; margin: 4px auto;
        background-color: #2d2d2d; color: #8fd9a0; font-size: 14px;
        border: 1px solid #2b7a3d; cursor: pointer; user-select: none;
      }
      .dls-banner:hover { background-color: #3a3a3a; color: #ffffff; }
      .dls-page-note {
        position: fixed; bottom: 12px; right: 12px; z-index: 9999;
        background: #2b7a3d; color: #fff; padding: 6px 12px; border-radius: 6px;
        font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
    `;
    document.head.append(style);

    // Reused rather than rebuilt: recreating it on every change set off
    // ChubDeslop's observer, which rebuilt its banner, which set off ours...
    const banner = document.createElement("div");
    banner.className = "dls-banner";
    banner.addEventListener("click", () => {
      showOwned = !showOwned;
      GM_setValue(site.toggleKey, showOwned);
      render();
    });

    function renderBanner(count, containers) {
      let text = "";
      if (!lists.length) text = site.noListText;
      else if (count) text = showOwned ? `Hide ${count} owned cards` : `Show ${count} owned cards`;
      const age = newest ? (Date.now() - newest) / 86400000 : 0;
      if (lists.length && age > STALE_DAYS) text += `${text ? " — " : ""}owned list is ${Math.floor(age)} days old; open ${appNames} to refresh`;
      const failed = syncError();
      if (failed) text += `${text ? " — " : ""}sync failed: ${failed}`;
      if (!text || !containers.length) {
        if (banner.isConnected) banner.remove();
        return;
      }
      if (banner.textContent !== text) banner.textContent = text;
      if (!site.placeBanner(banner, containers)) banner.remove();
    }

    function renderPageNote() {
      const id = site.pageId();
      const existing = document.querySelector(".dls-page-note");
      if (!id || !owned.has(id)) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const note = document.createElement("div");
      note.className = "dls-page-note";
      note.textContent = `Already in your ${appNames} library`;
      document.body.append(note);
    }

    function render() {
      let count = 0;
      for (const { el, id } of site.cards()) {
        // React and single-page sites reuse card elements, so marks are cleared as well as set
        if (!el) continue;
        const isOwned = !!id && owned.has(id);
        el.classList.toggle("dls-owned-hidden", isOwned && !showOwned);
        el.classList.toggle("dls-owned-shown", isOwned && showOwned);
        if (isOwned) count++;
      }
      renderBanner(count, site.containers());
      renderPageNote();
    }

    let timer = null;
    const banners = [".dls-banner", ".dls-page-note", site.otherBanners].filter(Boolean).join(", ");
    const observer = new MutationObserver((mutations) => {
      // Ignore banner changes, which don't add or remove cards
      const onlyBanners = mutations.every((m) => {
        if (m.target.nodeType === Node.ELEMENT_NODE && m.target.closest?.(banners)) return true;
        return [...m.addedNodes, ...m.removedNodes].every((n) => (n.nodeType === Node.ELEMENT_NODE ? n.matches?.(banners) : !n.textContent.trim()));
      });
      if (onlyBanners) return;
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Single-page navigation can change the page without adding cards (the page note)
    window.addEventListener("popstate", () => setTimeout(render, 150));
    render();
  }
})();
