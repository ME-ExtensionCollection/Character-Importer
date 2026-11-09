// Char Importer: pure helpers (no DOM, no network). Ported from the
// SillyTavern Dupe Link Skip extension, so link keys and content hashes match
// the ones that extension saved.

const ciCore = (() => {
  "use strict";

  const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

  function isValidUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function chubKey(parts) {
    parts = parts.filter(Boolean);
    const first = parts[0]?.toLowerCase();
    if (first === "lorebooks") return `chublore:${parts.slice(1).join("/").toLowerCase()}`;
    if (first === "characters") parts = parts.slice(1);
    return parts.length >= 2 ? `chub:${parts.slice(0, 2).join("/").toLowerCase()}` : "";
  }

  /**
   * Reduces a URL or bare ID to a stable key, so different spellings of the
   * same source (http/https, www, trailing slash, chub.ai vs characterhub.org,
   * bare ID vs link) compare equal. Same keys as Dupe Link Skip, plus the
   * sites Marinara's card browser knows (JannyAI, Wyvern, DataCat).
   * @returns {string} key, or "" if it can't be normalized
   */
  function normalizeSource(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return "";

    if (!isValidUrl(raw)) {
      // Bare IDs, mirroring SillyTavern's /importUUID routing
      if (raw.includes("~")) return `perchance:${raw.split("~")[1].toLowerCase()}`;
      if (raw.startsWith("AICC/")) return `aicc:${raw.split("/").slice(1, 3).join("/").toLowerCase()}`;
      const uuid = raw.match(UUID);
      if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
      return chubKey(raw.split("/"));
    }

    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);

    if (host.includes("chub.ai") || host.includes("characterhub.org")) return chubKey(parts);
    if (host.includes("perchance.org")) {
      const slug = raw.split("~")[1];
      return slug ? `perchance:${slug.toLowerCase()}` : "";
    }
    if (host.includes("realm.risuai.net")) return parts[1] ? `risu:${parts[1].toLowerCase()}` : "";
    if (host.includes("janitorai") || host.includes("jannyai") || host.includes("pygmalion.chat")) {
      const uuid = raw.match(UUID);
      if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
    }
    if (host.includes("wyvern.chat") && parts[0] === "characters" && parts[1]) return `wyvern:${parts[1].toLowerCase()}`;
    if (host.includes("datacat.run") && parts[0] === "characters" && parts[1]) return `datacat:${parts[1].toLowerCase()}`;
    if (host.includes("aicharactercards.com")) return `aicc:${parts.slice(-2).join("/").toLowerCase()}`;
    if (host === "botbooru.com") {
      if (parts[0] === "profile" && /^\d+$/.test(parts[1] ?? "")) return `botbooruuser:${parts[1]}`;
      // /character/<id>, /post/<id>, /download/png/<id>
      const id = ["character", "post"].includes(parts[0]) ? parts[1] : parts[0] === "download" ? parts[2] : "";
      if (/^\d+$/.test(id ?? "")) return `botbooru:${id}`;
    }

    return `url:${host}/${parts.join("/")}${url.search}`;
  }

  /** Key for Marinara's extensions.botBrowserSource ("<provider>:<id>"). */
  function keyFromBotBrowserSource(value) {
    if (typeof value !== "string") return "";
    const sep = value.indexOf(":");
    if (sep <= 0) return "";
    const provider = value.slice(0, sep).toLowerCase();
    const id = value.slice(sep + 1).trim();
    if (!id) return "";
    if (provider === "chub") return chubKey(id.split("/"));
    if ((provider === "janny" || provider === "pygmalion") && UUID.test(id)) return `uuid:${id.match(UUID)[0].toLowerCase()}`;
    return `${provider}:${id.toLowerCase()}`;
  }

  /** The card data object, whether given a raw V2/V3 card, ST character or Marinara data. */
  function cardData(card) {
    if (!card || typeof card !== "object") return {};
    return card.data && typeof card.data === "object" ? card.data : card;
  }

  /**
   * Every source key a character answers to. Mirrors SillyTavern's
   * getCharacterSource() plus Marinara's own markers.
   * @param {object} data card data (Marinara's parsed `data`)
   * @returns {string[]} unique keys, first one is the main key
   */
  function keysFromCard(data) {
    const ext = cardData(data).extensions ?? {};
    const keys = [];
    const add = (key) => {
      if (key && !keys.includes(key)) keys.push(key);
    };
    add(ext.char_importer?.source_key);
    // Other links the same card was found at (an identical copy skipped on import), and links of
    // differing copies merged into this one (obsolete versions): owned, hidden, never re-imported
    for (const field of ["also_keys", "obsolete_keys"]) {
      const list = ext.char_importer?.[field];
      for (const key of Array.isArray(list) ? list : []) if (typeof key === "string") add(key);
    }
    if (ext.chub?.full_path) add(normalizeSource(`https://chub.ai/characters/${ext.chub.full_path}`));
    add(keyFromBotBrowserSource(ext.botBrowserSource));
    if (/^\d+$/.test(String(ext.botbooru?.post_id ?? ""))) add(`botbooru:${ext.botbooru.post_id}`);
    if (ext.pygmalion_id) add(normalizeSource(`https://pygmalion.chat/${ext.pygmalion_id}`));
    if (ext.github_repo) add(normalizeSource(`https://github.com/${ext.github_repo}`));
    if (typeof ext.source_url === "string") add(normalizeSource(ext.source_url));
    const risu = ext.risuai?.source;
    if (Array.isArray(risu) && typeof risu[0] === "string" && risu[0].startsWith("risurealm:")) {
      add(`risu:${risu[0].split(":")[1].toLowerCase()}`);
    }
    if (ext.perchance_data?.slug) add(normalizeSource(ext.perchance_data.slug));
    const v3 = cardData(data).source;
    if (Array.isArray(v3)) for (const s of v3) if (typeof s === "string" && isValidUrl(s)) add(normalizeSource(s));
    return keys;
  }

  // SillyTavern's getStringHash (public/scripts/utils.js), verbatim, so hashes match.
  function getStringHash(str, seed = 0) {
    if (typeof str !== "string") return 0;
    let h1 = 0xdeadbeef ^ seed,
      h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  const CONTENT_FIELDS = [
    "name", "description", "personality", "scenario", "first_mes", "mes_example",
    "system_prompt", "post_history_instructions",
  ];

  /** Name or creator for matching: lowercase, letters and digits only, single spaces. */
  function normName(value) {
    return typeof value === "string" ? value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
  }

  // Botbooru's tag categories; card lists give bare names, so "general:cute" means "cute"
  const TAG_CATEGORY = /^(general|scenarios|auto|artist|copyright|language|settings|writer|meta):/;

  /** A tag for comparing: lowercase, spaces as underscores (Botbooru's spelling), no category prefix. */
  function normTag(value) {
    return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_").replace(TAG_CATEGORY, "") : "";
  }

  /** Botbooru uploader of a card (lowercase), from extensions.botbooru.full_path ("user/id"). */
  function botbooruUploader(data) {
    const path = cardData(data).extensions?.botbooru?.full_path;
    return typeof path === "string" && path.includes("/") ? path.split("/")[0].toLowerCase() : "";
  }

  function cleanText(value) {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  }

  /** The hash saved on the card before it was edited, if any. */
  function savedHash(card) {
    const ext = cardData(card).extensions ?? card?.extensions;
    return ext?.char_importer?.content_hash || ext?.dupe_link_skip?.content_hash || "";
  }

  /**
   * Hash of a card's content, ignoring metadata (creator, notes, tags,
   * version, extensions, avatar). Same algorithm as Dupe Link Skip.
   * @param {{ignoreSaved?: boolean}} [options]
   * @returns {string} hash, or "" if the card has no content to compare
   */
  function contentHash(card, { ignoreSaved = false } = {}) {
    if (!card) return "";
    if (!ignoreSaved) {
      const saved = savedHash(card);
      if (saved) return saved;
    }
    const get = (field) => card.data?.[field] ?? card[field];
    const fields = CONTENT_FIELDS.map((f) => cleanText(get(f)));
    const greetings = (Array.isArray(get("alternate_greetings")) ? get("alternate_greetings") : []).map(cleanText).filter(Boolean);
    const entries = get("character_book")?.entries;
    const book = (Array.isArray(entries) ? entries : []).map((e) => [
      (e.keys ?? []).map(cleanText).join(","),
      (e.secondary_keys ?? []).map(cleanText).join(","),
      cleanText(e.content),
    ]);
    // Name alone isn't enough to call two cards identical
    if (!fields.slice(1).some(Boolean) && !greetings.length) return "";
    const text = JSON.stringify([fields, greetings, book]);
    return `${getStringHash(text, 0).toString(36)}.${getStringHash(text, 1).toString(36)}`;
  }

  // ── Chub expression packs ──

  // Chub's stock placeholder images, used for packs that don't define every label
  const CHUB_STOCK_EXPRESSIONS = /lfs\.charhub\.io\/lfs\/88\/emotions\//;

  /** Default pack (sub null) and alt packs from extensions.chub. */
  function chubPacks(chub) {
    const packs = [];
    if (chub?.expressions) packs.push({ pack: chub.expressions, sub: null });
    for (const [version, pack] of Object.entries(chub?.alt_expressions ?? {})) {
      if (pack) packs.push({ pack, sub: version });
    }
    return packs;
  }

  /** [label, url] pairs of a pack, without Chub's stock placeholders. */
  function packEntries(pack) {
    const expressions = pack?.expressions;
    if (!expressions || typeof expressions !== "object") return [];
    return Object.entries(expressions).filter(
      ([label, url]) => label && typeof url === "string" && /^https?:\/\//.test(url) && !CHUB_STOCK_EXPRESSIONS.test(url),
    );
  }

  // ── Asset links in creator notes ──

  const ASSET_HOSTS = /catbox\.moe|drive\.google\.com|mega\.nz|pixeldrain\.com|mediafire\.com|dropbox\.com|files\.sillie\.st|\.zip(\?|$)/i;
  const ASSET_WORDS = /sprite|expression|emotion|outfit|pack|asset|lorebook|download/i;
  const NOTE_LINK = /https?:\/\/[^\s)\]"'<>]+/gi;

  const DEFAULT_LINK_BLACKLIST = Object.freeze([
    "ko-fi.com", "patreon.com", "buymeacoffee.com", "subscribestar.com", "subscribestar.adult", "linktr.ee",
    "discord.gg", "discord.com", "twitter.com", "x.com", "instagram.com", "tiktok.com", "youtube.com", "youtu.be",
  ]);

  /** Whether a link is dismissed or matches the blacklist (host incl. subdomains, or a URL fragment containing "/"). */
  function isLinkIgnored(url, blacklist, dismissed) {
    if (dismissed?.includes(url)) return true;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return false;
    }
    return (blacklist ?? []).some((pattern) => {
      pattern = String(pattern).trim().toLowerCase();
      if (!pattern) return false;
      if (pattern.includes("/")) return url.toLowerCase().includes(pattern);
      return host === pattern || host.endsWith(`.${pattern}`);
    });
  }

  /** Links in creator notes that look like extra assets: [{url, context}]. */
  function findAssetLinks(notes, blacklist, dismissed) {
    notes = String(notes ?? "");
    const found = [];
    for (const m of notes.matchAll(NOTE_LINK)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      // Images shown in the notes aren't extra assets
      if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url) || url.includes("/user/images/") || url.startsWith("card://")) continue;
      if (isLinkIgnored(url, blacklist, dismissed)) continue;
      const context = notes.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, " ");
      if ((ASSET_HOSTS.test(url) || ASSET_WORDS.test(context)) && !found.some((f) => f.url === url)) {
        found.push({ url, context: context.trim() });
      }
    }
    return found;
  }

  // ── Duplicate sets ──

  /**
   * Groups characters that share a source key or content hash (union-find).
   * @param {{id: string, keys: string[], hash: string, created: number}[]} entries
   * @returns {{identical: object[][], differing: object[][]}}
   *   identical: copies with the same hash, oldest first;
   *   differing: groups (same link) whose copies don't all have the same content
   */
  function findDuplicateSets(entries) {
    const parent = new Map();
    const find = (a) => {
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(parent.get(a)));
        a = parent.get(a);
      }
      return a;
    };
    const firstWith = new Map();
    const join = (id, by) => {
      if (!firstWith.has(by)) firstWith.set(by, id);
      else parent.set(find(id), find(firstWith.get(by)));
    };
    for (const entry of entries) {
      parent.set(entry.id, entry.id);
      for (const key of entry.keys ?? []) if (key && !key.startsWith("chublore:")) join(entry.id, `key:${key}`);
      if (entry.hash) join(entry.id, `hash:${entry.hash}`);
    }

    const clusters = new Map();
    for (const entry of entries) {
      const root = find(entry.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(entry);
    }

    const byAge = (a, b) => (a.created ?? 0) - (b.created ?? 0) || String(a.id).localeCompare(String(b.id));
    const identical = [];
    const differing = [];
    for (const cluster of clusters.values()) {
      if (cluster.length < 2) continue;
      const byHash = new Map();
      for (const entry of cluster) {
        const hash = entry.hash || `none:${entry.id}`;
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push(entry);
      }
      for (const copies of byHash.values()) if (copies.length > 1) identical.push([...copies].sort(byAge));
      if (byHash.size > 1) differing.push([...cluster].sort(byAge));
    }
    return { identical, differing };
  }

  // ── Import box input ──

  /** One link per non-empty line, trimmed, in order, without repeats. */
  function parseLinks(text) {
    const seen = new Set();
    const links = [];
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const link = line.trim();
      if (!link || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
    return links;
  }

  /** Filename-safe name (letters, digits, - _ . and spaces). */
  function safeName(value, fallback = "file") {
    const name = String(value ?? "").replace(/[^\p{L}\p{N}\-_. ]+/gu, "_").replace(/\s+/g, " ").trim().slice(0, 80);
    return name || fallback;
  }

  // ── Images saved by SillyTavern's Dupe Link Skip (/user/images/...) ──

  /** "/user/images/%20Monster%20Academy/embed-x.png" -> {folder: " Monster Academy", file: "embed-x.png"}, else null. */
  function stImagePath(src) {
    const m = String(src ?? "").match(/^\/user\/images\/(.+)$/);
    if (!m) return null;
    const parts = m[1].split("/").map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const file = parts.pop();
    if (!file) return null;
    return { folder: parts.join("/"), file };
  }

  /** Comparable folder or card name: no trailing digits, spaces or punctuation, lowercase. */
  const stFolderKey = (name) =>
    String(name ?? "")
      .replace(/\d+$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLowerCase();

  /**
   * Index of files picked with a folder picker. Keys on the last two path
   * segments, so picking "images" or a folder above it works the same.
   * @param {{path: string, file: unknown}[]} files path is webkitRelativePath
   */
  function stFileIndex(files) {
    const byPair = new Map();
    const byName = new Map();
    for (const { path, file } of files) {
      const parts = String(path).split("/");
      const name = parts.pop();
      const folder = parts.length > 1 ? parts.pop() : "";
      if (!name) continue;
      byPair.set(`${folder}/${name}`, file);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ folder, file });
    }
    return { byPair, byName, size: files.length };
  }

  /**
   * The picked file for an ST path: exact folder, else the same file name in a
   * folder that matches the card or path folder ("Airi" / "Airi6"), else that
   * file name in any folder. Dupe Link Skip names files by their web link, so
   * the same name is the same image.
   */
  function pickStFile(ref, index, cardName = "") {
    if (!ref || !index) return null;
    const exact = index.byPair.get(`${ref.folder.split("/").pop() ?? ""}/${ref.file}`);
    if (exact) return exact;
    const candidates = index.byName.get(ref.file);
    if (!candidates?.length) return null;
    const wanted = new Set([stFolderKey(ref.folder), stFolderKey(cardName)].filter(Boolean));
    return (candidates.find((c) => wanted.has(stFolderKey(c.folder))) ?? candidates[0]).file;
  }

  // ── Card tags through Tag Merger ──

  /** Marinara's tag match key (tagKey in st-character.importer.ts). */
  const tagKey = (tag) => String(tag).trim().toLocaleLowerCase();

  /**
   * Final tags for an imported card from Tag Merger's {canonical, other}:
   * canonicals always stay, other tags follow the Card tags mode.
   * @param {"all"|"existing"|"none"} mode
   * @param {Set<string>} [existingKeys] tagKey of every tag in the library, for "existing"
   */
  function composeImportTags({ canonical = [], other = [] } = {}, mode = "all", existingKeys = new Set()) {
    const kept = mode === "none" ? [] : mode === "existing" ? other.filter((t) => existingKeys.has(tagKey(t))) : other;
    const out = [];
    const seen = new Set();
    for (const tag of [...canonical, ...kept]) {
      if (typeof tag !== "string") continue;
      const key = tagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(tag.trim());
    }
    return out;
  }

  return Object.freeze({
    normName, normTag, botbooruUploader,
    UUID,
    isValidUrl,
    chubKey,
    normalizeSource,
    keyFromBotBrowserSource,
    cardData,
    keysFromCard,
    getStringHash,
    CONTENT_FIELDS,
    cleanText,
    savedHash,
    contentHash,
    CHUB_STOCK_EXPRESSIONS,
    chubPacks,
    packEntries,
    ASSET_HOSTS,
    ASSET_WORDS,
    DEFAULT_LINK_BLACKLIST,
    isLinkIgnored,
    findAssetLinks,
    findDuplicateSets,
    parseLinks,
    safeName,
    tagKey,
    composeImportTags,
    stImagePath,
    stFileIndex,
    pickStFile,
  });
})();
