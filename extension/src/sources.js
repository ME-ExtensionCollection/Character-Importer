// Char Importer: turns a pasted link into a card ready for Marinara's
// importer. Sites Marinara's card browser knows go through its server proxy
// routes (no CORS problem); others are fetched directly or through the
// companion userscript.

const ciSources = (() => {
  "use strict";

  class UnsupportedLinkError extends Error {}

  const encPath = (path) => String(path).split("/").map(encodeURIComponent).join("/");
  const str = (value) => (typeof value === "string" && value.trim() ? value : undefined);
  const strArray = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()) : []);

  /**
   * What a link points at.
   * @returns {{link: string, key: string, kind: "character"|"lorebook", provider: string, id: string, label: string}}
   */
  function resolve(link) {
    const key = ciCore.normalizeSource(link);
    if (!key) throw new UnsupportedLinkError("Not a link or ID this importer understands");
    const [prefix] = key.split(":", 1);
    const rest = key.slice(prefix.length + 1);
    const isUrl = ciCore.isValidUrl(link);
    const host = isUrl ? new URL(link).hostname.toLowerCase() : "";

    if (prefix === "chub") {
      // Keep the creator/slug spelling from the link: Chub's file paths are case-sensitive.
      const parts = (isUrl ? new URL(link).pathname : link).split("/").filter(Boolean);
      const path = (parts[0]?.toLowerCase() === "characters" ? parts.slice(1) : parts).slice(0, 2).join("/");
      return { link, key, kind: "character", provider: "chub", id: path, label: `Chub ${path}` };
    }
    if (prefix === "chublore") {
      const parts = new URL(link).pathname.split("/").filter(Boolean).slice(1, 3);
      return { link, key, kind: "lorebook", provider: "chublore", id: parts.join("/"), label: `Chub lorebook ${parts.join("/")}` };
    }
    if (prefix === "uuid") {
      const provider = host.includes("pygmalion") ? "pygmalion" : host.includes("janitorai") || host.includes("jannyai") ? "janny" : "uuid";
      return { link, key, kind: "character", provider, id: rest, label: `${provider === "pygmalion" ? "Pygmalion" : "JanitorAI"} ${rest.slice(0, 8)}` };
    }
    if (prefix === "wyvern" || prefix === "datacat") {
      // Keep the id's case from the link.
      const id = new URL(link).pathname.split("/").filter(Boolean)[1];
      return { link, key, kind: "character", provider: prefix, id, label: `${prefix === "wyvern" ? "Wyvern" : "DataCat"} ${id}` };
    }
    if (prefix === "risu") {
      const id = isUrl ? new URL(link).pathname.split("/").filter(Boolean)[1] : rest;
      return { link, key, kind: "character", provider: "risu", id, label: `RisuRealm ${id.slice(0, 12)}` };
    }
    if (prefix === "aicc") {
      const parts = (isUrl ? new URL(link).pathname : link).split("/").filter(Boolean);
      const id = parts.slice(-2).join("/");
      return { link, key, kind: "character", provider: "aicc", id, label: `AICC ${id}` };
    }
    if (prefix === "botbooruuser") return { link, key, kind: "list", provider: "botbooru", id: rest, label: `Botbooru profile ${rest}` };
    if (prefix === "botbooru") return { link, key, kind: "character", provider: "botbooru", id: rest, label: `Botbooru ${rest}` };
    if (prefix === "perchance") throw new UnsupportedLinkError("Perchance links aren't supported yet. Download the card and use Marinara's file import.");
    if (prefix === "url") return { link, key, kind: "character", provider: "url", id: link, label: host || link };
    throw new UnsupportedLinkError("Not a link or ID this importer understands");
  }

  /** Marinara's own source marker, only for sites its card browser has (it lists those under Downloaded). */
  function botBrowserSource(plan, card) {
    if (plan.provider === "chub") return `chub:${card?.fullPath ?? plan.id}`;
    if (plan.provider === "janny") return `janny:${plan.id}`;
    if (plan.provider === "pygmalion") return `pygmalion:${plan.id}`;
    if (plan.provider === "wyvern") return `wyvern:${plan.id}`;
    if (plan.provider === "datacat") return `datacat:${plan.id}`;
    return undefined;
  }

  // ── Card shaping ──

  /** The object fields live on: data for V2/V3, the card itself for V1. Clones the card. */
  function editable(card) {
    const cloned = structuredClone(card);
    const isWrapped = (cloned.spec === "chara_card_v2" || cloned.spec === "chara_card_v3") && cloned.data && typeof cloned.data === "object";
    return { card: cloned, target: isWrapped ? cloned.data : cloned };
  }

  /** ME's mergeChubDetailIntoCharacterJson (client/src/lib/chub-character-card.ts). */
  function mergeChubDetail(raw, summary, detail) {
    if (!detail) return raw;
    const { card, target } = editable(raw);
    const set = (field, value) => {
      if (typeof value === "string" && value.trim()) target[field] = value;
    };
    set("description", detail.description);
    set("personality", detail.personality);
    set("scenario", detail.scenario);
    set("first_mes", detail.firstMessage);
    set("mes_example", detail.exampleDialogs);
    set("creator_notes", detail.creatorNotes);
    set("system_prompt", detail.systemPrompt);
    set("post_history_instructions", detail.postHistoryInstructions);
    set("character_version", detail.characterVersion);
    if (!str(target.name) && str(summary.name)) target.name = summary.name;
    if (!str(target.creator) && str(summary.creator)) target.creator = summary.creator;
    if (!strArray(target.tags).length && strArray(summary.tags).length) target.tags = strArray(summary.tags);
    const greetings = strArray(detail.alternateGreetings).map((g) => g.trim());
    if (greetings.length) target.alternate_greetings = greetings;
    if (detail.extensions) target.extensions = { ...(target.extensions && typeof target.extensions === "object" ? target.extensions : {}), ...detail.extensions };
    const entries = detail.embeddedLorebook?.entries;
    if (!target.character_book && entries && (Array.isArray(entries) ? entries.length : Object.keys(entries).length)) target.character_book = detail.embeddedLorebook;
    return card;
  }

  /** V2 card from a site's detail fields (sites without card files). */
  function rebuiltCard(detail, summary, extensions) {
    const description = detail.description || "";
    const personality = detail.personality || "";
    const data = {
      name: summary.name || "Unnamed",
      description: description || personality,
      personality: personality && description ? personality : "",
      scenario: detail.scenario || "",
      first_mes: detail.firstMessage || "",
      mes_example: detail.exampleDialogs || "",
      creator_notes: detail.creatorNotes || "",
      system_prompt: detail.systemPrompt || "",
      post_history_instructions: detail.postHistoryInstructions || "",
      character_version: detail.characterVersion || "",
      tags: strArray(summary.tags),
      creator: summary.creator || "",
      alternate_greetings: strArray(detail.alternateGreetings),
      extensions: extensions ?? {},
    };
    const entries = detail.embeddedLorebook?.entries;
    if (entries && (Array.isArray(entries) ? entries.length : Object.keys(entries).length)) data.character_book = detail.embeddedLorebook;
    return { spec: "chara_card_v2", spec_version: "2.0", data };
  }

  function isCharacterCard(card) {
    if (!card || typeof card !== "object") return false;
    const data = ciCore.cardData(card);
    return typeof data.name === "string" && ("description" in data || "first_mes" in data || "personality" in data || "char_persona" in data);
  }

  function isLorebook(json) {
    return !!json && typeof json === "object" && !isCharacterCard(json) && json.entries && typeof json.entries === "object";
  }

  async function avatarFromProxy(path) {
    if (!path) return null;
    try {
      const { bytes, contentType } = await ciNet.fetchLocal(path, { timeoutMs: 20_000 });
      const mime = ciPng.sniffImageType(bytes) || contentType.split(";")[0];
      return mime.startsWith("image/") ? ciPng.toDataUrl(bytes, mime) : null;
    } catch {
      return null;
    }
  }

  const proxied = (base, src) => (src ? (src.startsWith("http") ? `${base}/${encodeURIComponent(src)}` : `${base}/${encPath(src)}`) : "");

  // ── Loaders: each returns {card, avatarDataUrl, fullPath?} ──

  // Chub refuses some regions (403 "not available in your country"). When
  // Marinara's server is refused, this browser may still get through (VPN),
  // so ask from here and skip the server for a while.
  const SERVER_RETRY_MS = 10 * 60 * 1000;
  let chubServerRefusedAt = 0;

  async function fetchChubDetail(path, signal) {
    const pick = (raw) => raw?.data?.node ?? raw?.node ?? null;
    if (Date.now() - chubServerRefusedAt > SERVER_RETRY_MS) {
      try {
        return pick(await ciNet.fetchLocalJson(`/api/bot-browser/chub/character/${encPath(path)}`, { signal }));
      } catch (error) {
        if (signal?.aborted || (error instanceof ciNet.HttpError && error.status === 404) || error instanceof ciNet.RateLimitError) throw error;
        chubServerRefusedAt = Date.now();
        marinara.log.warn("Marinara's server couldn't read Chub; asking from this browser instead", error);
      }
    }
    return pick(await ciNet.fetchRemoteJson(`https://api.chub.ai/api/characters/${encPath(path)}?full=true&nocache=${Date.now()}`, { signal }));
  }

  function chubDetailFields(node) {
    const def = node?.definition ?? {};
    return {
      description: str(def.personality),
      personality: str(def.tavern_personality),
      scenario: str(def.scenario),
      firstMessage: str(def.first_message),
      exampleDialogs: str(def.example_dialogs),
      alternateGreetings: strArray(def.alternate_greetings),
      creatorNotes: str(def.description),
      systemPrompt: str(def.system_prompt),
      postHistoryInstructions: str(def.post_history_instructions),
      characterVersion: str(def.character_version),
      embeddedLorebook: def.embedded_lorebook,
      extensions: def.extensions && typeof def.extensions === "object" ? def.extensions : undefined,
    };
  }

  async function loadChub(plan, signal) {
    let node = null;
    try {
      node = await fetchChubDetail(plan.id, signal);
    } catch (error) {
      if (error instanceof ciNet.HttpError && error.status === 404) throw new ciNet.HttpError(404, "Chub has no character at this link");
      if (!(error instanceof ciNet.HttpError)) throw error;
    }
    const fullPath = str(node?.fullPath) ?? plan.id;
    const summary = { name: node?.name, creator: fullPath.split("/")[0], tags: strArray(node?.topics) };
    const detail = node ? chubDetailFields(node) : null;
    let png = null;
    try {
      png = (await ciNet.fetchLocal(`/api/bot-browser/chub/download/${encPath(fullPath)}`, { signal, timeoutMs: 60_000 })).bytes;
    } catch (error) {
      if (!node) throw error;
    }
    const parsed = png ? await ciPng.readCard(png) : null;
    if (parsed) {
      return { card: mergeChubDetail(parsed, summary, detail), avatarDataUrl: ciPng.toDataUrl(png, "image/png"), fullPath };
    }
    if (!detail) throw new Error("Chub's card file has no character data");
    const card = rebuiltCard(detail, summary, detail.extensions);
    const avatarDataUrl =
      (await avatarFromProxy(`/api/bot-browser/chub/avatar/${encPath(fullPath)}?full=1`)) ??
      (await chubAvatarFromNode(node, signal));
    return { card, avatarDataUrl, fullPath };
  }

  // Newer Chub cards keep their picture outside avatars/<fullPath>/ (e.g.
  // avatars/uploads/images/gallery/…), which Marinara's proxy doesn't look at.
  // The character's own avatar_url / max_res_url point at it.
  async function chubAvatarFromNode(node, signal) {
    const urls = [node?.max_res_url, node?.avatar_url].filter(
      (u, i, all) => typeof u === "string" && /^https:\/\/([^/]+\.)?(charhub\.io|chub\.ai|characterhub\.org)\//i.test(u) && all.indexOf(u) === i,
    );
    for (const url of urls) {
      try {
        const { bytes, contentType } = await ciNet.fetchRemote(url, { signal, timeoutMs: 20_000 });
        const mime = ciPng.sniffImageType(bytes) || contentType.split(";")[0];
        if (mime.startsWith("image/")) return ciPng.toDataUrl(bytes, mime);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return null;
  }

  async function loadPngFromProxy(path, signal) {
    const { bytes } = await ciNet.fetchLocal(path, { signal, timeoutMs: 90_000 });
    const card = await ciPng.readCard(bytes);
    if (!card) throw new Error("The downloaded card has no character data");
    return { card, avatarDataUrl: ciPng.isPng(bytes) ? ciPng.toDataUrl(bytes, "image/png") : null };
  }

  async function loadPygmalion(plan, signal) {
    const data = await ciNet.fetchLocalJson(`/api/bot-browser/pygmalion/character?id=${encodeURIComponent(plan.id)}`, { signal });
    const char = data?.character;
    if (!char) throw new Error("Pygmalion returned no character (it may need a login in Marinara's card browser)");
    const p = char.personality ?? {};
    const detail = {
      description: p.persona,
      firstMessage: p.greeting,
      exampleDialogs: p.mesExample,
      creatorNotes: p.characterNotes,
      systemPrompt: str(p.systemPrompt ?? p.system_prompt ?? char.systemPrompt ?? char.system_prompt),
      postHistoryInstructions: str(p.postHistoryInstructions ?? p.post_history_instructions ?? char.postHistoryInstructions ?? char.post_history_instructions),
      characterVersion: str(p.characterVersion ?? p.character_version ?? char.characterVersion ?? char.character_version),
      alternateGreetings: strArray(p.alternateGreetings),
    };
    const summary = { name: char.displayName, creator: char.owner?.username || char.owner?.displayName, tags: strArray(char.tags) };
    return {
      card: rebuiltCard(detail, summary, { pygmalion: { id: plan.id }, pygmalion_id: plan.id }),
      avatarDataUrl: await avatarFromProxy(proxied("/api/bot-browser/pygmalion/avatar", char.avatarUrl)),
    };
  }

  async function loadWyvern(plan, signal) {
    const c = await ciNet.fetchLocalJson(`/api/bot-browser/wyvern/character/${encodeURIComponent(plan.id)}`, { signal });
    if (!c) throw new Error("Wyvern returned no character");
    const detail = {
      description: c.description,
      personality: c.personality,
      scenario: c.scenario,
      firstMessage: c.first_mes,
      exampleDialogs: c.mes_example,
      creatorNotes: c.creator_notes,
      systemPrompt: str(c.systemPrompt ?? c.system_prompt),
      postHistoryInstructions: str(c.postHistoryInstructions ?? c.post_history_instructions),
      characterVersion: str(c.characterVersion ?? c.character_version),
      alternateGreetings: strArray(c.alternate_greetings),
      embeddedLorebook: c.embedded_lorebook ?? c.character_book,
    };
    const summary = { name: c.name, creator: c.creator?.displayName || c.creator?.username, tags: strArray(c.tags) };
    const src = c.avatar_url || c.avatar;
    const avatar = src ? (src.startsWith("http") ? proxied("/api/bot-browser/wyvern/avatar", src) : `/api/bot-browser/wyvern/avatar/${encPath(src)}/public`) : "";
    return { card: rebuiltCard(detail, summary, { wyvern: { id: plan.id } }), avatarDataUrl: await avatarFromProxy(avatar) };
  }

  async function loadDatacat(plan, signal) {
    const dl = await ciNet.fetchLocalJson(`/api/bot-browser/datacat/download/${encodeURIComponent(plan.id)}`, { signal });
    const d = dl?.data;
    if (!d) throw new Error("DataCat returned no character");
    const detail = {
      description: d.description || d.personality,
      personality: d.personality,
      scenario: d.scenario,
      firstMessage: d.first_mes,
      exampleDialogs: d.mes_example,
      creatorNotes: d.creator_notes,
      systemPrompt: str(d.systemPrompt ?? d.system_prompt),
      postHistoryInstructions: str(d.postHistoryInstructions ?? d.post_history_instructions),
      characterVersion: str(d.characterVersion ?? d.character_version),
      alternateGreetings: strArray(d.alternate_greetings),
      embeddedLorebook: d.character_book,
    };
    const summary = { name: d.name, creator: d.creator, tags: strArray(d.tags) };
    const av = d.avatar || dl.avatar || "";
    return { card: rebuiltCard(detail, summary, { datacat: { id: plan.id } }), avatarDataUrl: await avatarFromProxy(proxied("/api/bot-browser/datacat/avatar", av)) };
  }

  const CARD_ACCEPT = "image/png,application/json,*/*";

  /** A remote card file (PNG or JSON), direct or via the userscript. */
  async function loadRemoteFile(url, signal) {
    return parseCardFile(await ciNet.fetchRemote(url, { signal, accept: CARD_ACCEPT, timeoutMs: 30_000 }));
  }

  async function parseCardFile({ bytes, contentType }) {
    const json = await ciPng.readCard(bytes);
    if (!json) {
      if (contentType.includes("text/html")) throw new Error("That link is a web page, not a card file");
      throw new Error("No character data in the downloaded file");
    }
    return { json, avatarDataUrl: ciPng.isPng(bytes) ? ciPng.toDataUrl(bytes, "image/png") : null };
  }

  /**
   * RisuRealm: PNG card if the creator allows it, otherwise the .charx
   * (a zip with card.json and assets), which Marinara imports as a file.
   */
  async function loadRisu(plan, signal) {
    const base = `https://realm.risuai.net/api/v1/download`;
    const id = encodeURIComponent(plan.id);
    try {
      const file = await loadRemoteFile(`${base}/png-v3/${id}?non_commercial=true`, signal);
      return { card: file.json, avatarDataUrl: file.avatarDataUrl };
    } catch (error) {
      // 403 "not allowed to be downloaded in this format"
      if (!(error instanceof ciNet.HttpError) || (error.status !== 403 && error.status !== 400)) throw error;
    }
    const { bytes } = await ciNet.fetchRemote(`${base}/charx-v3/${id}?non_commercial=true`, { signal, timeoutMs: 60_000 });
    const json = await ciPng.unzipEntry(bytes, "card.json");
    if (!json) throw new Error("The RisuRealm .charx has no card.json");
    return { card: JSON.parse(new TextDecoder().decode(json)), avatarDataUrl: null, charx: bytes };
  }

  /** github.com/<o>/<r>/blob/<ref>/<path> -> raw file. */
  function rawGithub(url) {
    const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
  }

  /**
   * Downloads a card.
   * @returns {Promise<{type: "character", card: object, avatarDataUrl: string|null, botBrowserSource?: string} | {type: "lorebook", json: object, name: string}>}
   */
  async function load(plan, { signal } = {}) {
    if (plan.kind === "lorebook") return { type: "lorebook", ...(await loadChubLorebook(plan.id, signal)) };
    let result;
    switch (plan.provider) {
      case "chub":
        result = await loadChub(plan, signal);
        break;
      case "janny":
        result = await loadPngFromProxy(`/api/bot-browser/janny/download/${encodeURIComponent(plan.id)}`, signal);
        break;
      case "uuid":
        // A bare ID: JanitorAI first (via JannyAI), then Pygmalion
        try {
          result = await loadPngFromProxy(`/api/bot-browser/janny/download/${encodeURIComponent(plan.id)}`, signal);
          plan = { ...plan, provider: "janny" };
        } catch (error) {
          if (signal?.aborted) throw error;
          result = await loadPygmalion(plan, signal);
          plan = { ...plan, provider: "pygmalion" };
        }
        break;
      case "pygmalion":
        result = await loadPygmalion(plan, signal);
        break;
      case "wyvern":
        result = await loadWyvern(plan, signal);
        break;
      case "datacat":
        result = await loadDatacat(plan, signal);
        break;
      case "risu":
        result = await loadRisu(plan, signal);
        break;
      case "aicc": {
        const file = await loadRemoteFile(`https://aicharactercards.com/wp-json/pngapi/v1/image/${encPath(plan.id)}`, signal);
        result = { card: file.json, avatarDataUrl: file.avatarDataUrl };
        break;
      }
      case "botbooru": {
        // The PNG has the card, avatar and lorebook; the gallery is an asset step (needs a login)
        const file = await loadBotbooruCard(plan.id, signal);
        result = { card: file.json, avatarDataUrl: file.avatarDataUrl, botbooruRecorded: file.recorded };
        break;
      }
      default: {
        const file = await loadRemoteFile(rawGithub(plan.link), signal);
        if (isLorebook(file.json)) {
          const name = decodeURIComponent(new URL(plan.link).pathname.split("/").pop() || "lorebook").replace(/\.json$/i, "");
          return { type: "lorebook", json: file.json, name };
        }
        result = { card: file.json, avatarDataUrl: file.avatarDataUrl };
      }
    }
    if (!isCharacterCard(result.card)) throw new Error("The downloaded file isn't a character card");
    return {
      type: "character", card: result.card, avatarDataUrl: result.avatarDataUrl ?? null, charx: result.charx ?? null,
      botBrowserSource: botBrowserSource(plan, result), provider: plan.provider, botbooruRecorded: !!result.botbooruRecorded,
    };
  }

  // ── Botbooru (with your login, through the userscript) ──

  /** Why Botbooru couldn't be read with a login: "login", "refused", "old-companion" or "no-companion". */
  class BotbooruAccessError extends Error {
    constructor(reason, message) {
      super(message);
      this.reason = reason;
    }
  }

  // After a refusal, later requests skip asking for a little while (one per card otherwise)
  let botbooruBlocked = null; // {error, at}
  const resetBotbooruBlock = () => void (botbooruBlocked = null);

  /** JSON from a botbooru.com path, sent with your Botbooru login. */
  async function fetchBotbooru(path, signal) {
    if (botbooruBlocked && Date.now() - botbooruBlocked.at < 2 * 60 * 1000) throw botbooruBlocked.error;
    try {
      return await requestBotbooru(path, signal);
    } catch (error) {
      if (error instanceof BotbooruAccessError) botbooruBlocked = { error, at: Date.now() };
      throw error;
    }
  }

  async function requestBotbooru(path, signal) {
    if (!(await ciBridge.detect(600))) throw new BotbooruAccessError("no-companion", "Needs the companion userscript to use your Botbooru login");
    if (!ciBridge.canUseLogin("botbooru.com")) throw new BotbooruAccessError("old-companion", "Needs companion userscript 2.7 or newer");
    try {
      return await ciNet.fetchRemoteJson(`https://botbooru.com${path}`, { signal, siteLogin: true });
    } catch (error) {
      // Botbooru answers 401, or 404 {"detail":"login_required"} on posts, without a valid login (none yet, or expired)
      if (error instanceof ciNet.HttpError && [401, 403, 404].includes(error.status)) throw new BotbooruAccessError("login", "Botbooru didn't accept the saved login; open botbooru.com in this browser while logged in");
      if (error instanceof ciBridge.BridgeError) {
        if (error.kind === "no-login") throw new BotbooruAccessError("login", error.message);
        if (error.kind === "login-refused") throw new BotbooruAccessError("refused", error.message);
        // An older userscript only allows the login on character pages
        if (error.kind === "bad-url") throw new BotbooruAccessError("old-companion", "Needs companion userscript 2.7 or newer");
      }
      throw error;
    }
  }

  // Botbooru spaces its own quick downloads 1.2-1.9 s apart and sends
  // "X-Botbooru-Pace: warn" when a client should slow down (it then waits 3 s)
  const BOTBOORU_GAP_MS = 2000;
  const BOTBOORU_SLOW_GAP_MS = 5000;
  let lastBotbooruDownload = 0;
  let botbooruSlowUntil = 0;

  /**
   * A Botbooru card PNG. Sent with your login when it can be, so Botbooru
   * counts the download for your account (its "Downloaded" filter and
   * "Only updated" view); otherwise downloaded anonymously, as the card
   * itself is public. The gallery step after it says when the login is missing.
   * @returns {Promise<{json: object, avatarDataUrl: string|null, recorded: boolean}>} recorded: sent with the login
   */
  async function loadBotbooruCard(id, signal) {
    const gap = Date.now() < botbooruSlowUntil ? BOTBOORU_SLOW_GAP_MS : BOTBOORU_GAP_MS;
    const wait = lastBotbooruDownload + gap - Date.now();
    if (wait > 0) await ciNet.sleep(wait, signal);
    const url = `https://botbooru.com/download/png/${encodeURIComponent(id)}`;
    const options = { signal, accept: CARD_ACCEPT, timeoutMs: 30_000 };
    let response = null;
    let recorded = false;
    try {
      if ((await ciBridge.detect(600)) && ciBridge.canUseLogin("botbooru.com")) {
        try {
          response = await ciNet.fetchRemote(url, { ...options, siteLogin: true });
          recorded = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          const loginProblem =
            (error instanceof ciBridge.BridgeError && ["no-login", "login-refused", "bad-url"].includes(error.kind)) ||
            (error instanceof ciNet.HttpError && [401, 403].includes(error.status));
          if (!loginProblem) throw error;
        }
      }
      response ??= await ciNet.fetchRemote(url, options);
    } finally {
      lastBotbooruDownload = Date.now();
    }
    if (response.header?.("x-botbooru-pace") === "warn") botbooruSlowUntil = Date.now() + 5 * 60 * 1000;
    return { ...(await parseCardFile(response)), recorded };
  }

  /** Whether Botbooru has this card down as downloaded by your account (needs the login). */
  async function botbooruKnows(id, signal) {
    const post = await fetchBotbooru(`/post/${encodeURIComponent(id)}`, signal);
    return post?.downloaded_by_me === true;
  }

  const BOTBOORU_PAGE = 100; // the most /api/users takes

  /**
   * Every card a Botbooru user uploaded, newest first. Checks the login
   * first: logged out, Botbooru quietly lists only the safe-for-work few.
   * `state` is Botbooru's record for your account: "current" (downloaded),
   * "updated" (changed since you downloaded it) or "" (never downloaded).
   * @returns {Promise<{name: string, cards: {link: string, id: string, state: string}[]}>}
   */
  async function listBotbooruProfile(userId, { signal, onProgress } = {}) {
    await fetchBotbooru("/auth/me", signal);
    const cards = [];
    const seen = new Set();
    let name = `user ${userId}`;
    for (let offset = 0; offset < 10_000; offset += BOTBOORU_PAGE) {
      const page = await fetchBotbooru(`/api/users/${userId}?upload_limit=${BOTBOORU_PAGE}&upload_offset=${offset}&upload_sort=latest`, signal);
      name = str(page?.username) ?? name;
      const uploads = Array.isArray(page?.uploads) ? page.uploads : [];
      for (const upload of uploads) {
        const id = String(upload?.id ?? "");
        if (!/^\d+$/.test(id) || (upload.status && upload.status !== "active") || seen.has(id)) continue;
        seen.add(id);
        cards.push({ link: `https://botbooru.com/character/${id}`, id, state: typeof upload.download_state === "string" ? upload.download_state : "" });
      }
      const total = Number(page?.uploads_list_total) || 0;
      onProgress?.(cards.length, total);
      if (uploads.length < BOTBOORU_PAGE || offset + BOTBOORU_PAGE >= total) break;
      await ciNet.sleep(1000, signal);
    }
    return { name, cards };
  }

  // ── Chub lorebooks ──

  /** @returns {Promise<{json: object, name: string, path: string}>} */
  async function loadChubLorebook(path, signal) {
    const meta = await ciNet.fetchRemoteJson(`https://api.chub.ai/api/lorebooks/${encPath(path)}?full=true`, { signal });
    const projectId = meta?.node?.id;
    if (!projectId) throw new Error(`Chub has no lorebook at ${path}`);
    const json = await ciNet.fetchRemoteJson(
      `https://api.chub.ai/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/raw%252Fsillytavern_raw.json/raw`,
      { signal },
    );
    if (!json?.entries) throw new Error(`Chub's lorebook ${path} has no entries`);
    return { json, name: str(meta.node.name) ?? path.split("/").pop(), path };
  }

  /**
   * Adds our marker to a card's extensions (V2/V3: data.extensions; V1: extensions).
   * @returns {object} new card
   */
  function withMarker(card, marker) {
    const { card: cloned, target } = editable(card);
    target.extensions = { ...(target.extensions && typeof target.extensions === "object" ? target.extensions : {}), char_importer: marker };
    return cloned;
  }

  return Object.freeze({ UnsupportedLinkError, BotbooruAccessError, fetchBotbooru, resetBotbooruBlock, listBotbooruProfile, loadBotbooruCard, botbooruKnows, resolve, load, loadChubLorebook, fetchChubDetail, withMarker, isCharacterCard, isLorebook, editable });
})();
