// Char Importer: Marinara REST calls. All go through marinara.fetch so
// Settings > Addons attributes the traffic to this extension. Writes carry
// the x-marinara-csrf header Marinara requires.

const ciApi = (() => {
  "use strict";

  const PAGE_SIZE = 100;
  const JSON_HEADERS = { "Content-Type": "application/json", "x-marinara-csrf": "1" };
  const CSRF_ONLY = { "x-marinara-csrf": "1" };
  const enc = encodeURIComponent;

  async function readError(response) {
    try {
      const body = await response.json();
      return body?.error || body?.message || "";
    } catch {
      return "";
    }
  }

  async function request(path, init = {}) {
    const response = await marinara.fetch(path, init);
    if (!response.ok) {
      const message = await readError(response);
      if (response.status === 429) {
        throw new ciNet.RateLimitError(message || "Marinara rate limit reached", Number(response.headers.get("retry-after")) * 1000 || 60_000);
      }
      throw new ciNet.HttpError(response.status, message || `${init.method ?? "GET"} ${path.split("?")[0]} failed (${response.status})`);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") ?? "";
    return type.includes("json") ? response.json() : response.text();
  }

  const getJson = (path) => request(path);
  const send = (method, path, body) => request(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });

  function parseRow(row) {
    if (!row) return null;
    let data = row.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = {};
      }
    }
    return { id: row.id, data: data ?? {}, avatarPath: row.avatarPath ?? null, comment: row.comment ?? "", createdAt: row.createdAt ?? "", updatedAt: row.updatedAt ?? "" };
  }

  // ── Characters ──

  /** Every character as catalog entries {id, name, createdAt, updatedAt, avatarPath, tags, favorite}. Restarts if the library changes mid-read. */
  async function listCatalog(onProgress) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const items = [];
      let generation;
      let offset = 0;
      let restarted = false;
      for (;;) {
        const page = await getJson(`/api/characters/catalog?limit=${PAGE_SIZE}&offset=${offset}`);
        generation ??= page.catalogGeneration;
        if (page.catalogGeneration !== generation) {
          restarted = true;
          break;
        }
        items.push(...(page.items ?? []));
        onProgress?.(items.length);
        if (!page.hasMore || !page.items?.length) break;
        offset += page.items.length;
      }
      if (!restarted) return { items, generation };
    }
    throw new Error("The character library kept changing while loading. Try again.");
  }

  /** Full rows, oldest first, one page at a time (new characters land at the end). */
  async function* iterateCharacters() {
    for (let offset = 0; ; ) {
      const page = await getJson(`/api/characters?limit=${PAGE_SIZE}&offset=${offset}&sort=oldest`);
      const rows = (page.items ?? []).map(parseRow);
      yield rows;
      if (!page.hasMore || !rows.length) return;
      offset += rows.length;
    }
  }

  const getCharacter = async (id) => parseRow(await getJson(`/api/characters/${enc(id)}`));

  /**
   * POST /api/import/st-character with a JSON card. Marinara answers 200 even
   * on failure, with success:false.
   * @returns {Promise<{characterId: string, name: string, lorebook?: object}>}
   */
  async function importCharacter(card, options) {
    const result = await send("POST", "/api/import/st-character", { ...card, ...options });
    if (!result?.success || !result.characterId) throw new ciNet.LocalSaveError(result?.error || "Marinara could not import the card");
    return result;
  }

  /** Imports a card file (e.g. .charx with its assets) the way Marinara's file import does. */
  async function importCharacterFile(bytes, filename, options) {
    const form = new FormData();
    // Fields go before the file: Marinara reads the ones that precede it
    for (const key of ["importEmbeddedLorebook", "tagImportMode", "regexScriptScope", "splitDescription"]) {
      if (options[key] !== undefined) form.append(key, String(options[key]));
    }
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), filename);
    const result = await request("/api/import/st-character", { method: "POST", headers: CSRF_ONLY, body: form });
    if (!result?.success || !result.characterId) throw new ciNet.LocalSaveError(result?.error || "Marinara could not import the card file");
    return result;
  }

  /** PATCH card data; extensions are merged, other fields replaced. */
  function updateCharacter(id, data, { versionSource = "char-importer", versionReason, skipVersionSnapshot = false } = {}) {
    return send("PATCH", `/api/characters/${enc(id)}`, { data, versionSource, versionReason, skipVersionSnapshot }).then(parseRow);
  }

  const deleteCharacter = (id) => request(`/api/characters/${enc(id)}`, { method: "DELETE", headers: CSRF_ONLY });

  /** @returns {Promise<{updatedIds: string[], unchangedIds: string[], failedIds: string[]}>} */
  function bulkTags(ids, { add, remove } = {}) {
    if (!ids.length) return Promise.resolve({ updatedIds: [], unchangedIds: [], failedIds: [] });
    return send("POST", "/api/characters/bulk-tags", { ids, add, remove });
  }

  async function exportCharacter(id) {
    const response = await marinara.fetch(`/api/characters/${enc(id)}/export`);
    if (!response.ok) throw new ciNet.HttpError(response.status, (await readError(response)) || `Export failed (${response.status})`);
    return response.text();
  }

  const importMarinara = (json) => send("POST", "/api/import/marinara", json);
  const duplicates = () => getJson("/api/characters/duplicates");

  // ── Sprites ──

  const listSprites = (id) => getJson(`/api/sprites/${enc(id)}`);
  const spriteCatalog = (id) => getJson(`/api/sprites/${enc(id)}/catalog`);
  const createSpriteFolder = (id, name, category = "expressions") => send("POST", `/api/sprites/${enc(id)}/folders`, { name, category });

  /**
   * Upload one sprite. folderId is always sent (null = unfiled): without it
   * Marinara replaces an existing sprite with the same name.
   * @returns {Promise<object|null>} sprite info, or null if that label already exists in the folder
   */
  async function uploadSprite(id, { expression, image, folderId = null }) {
    try {
      return await send("POST", `/api/sprites/${enc(id)}`, { expression, image, folderId: folderId ?? null });
    } catch (error) {
      if (error instanceof ciNet.HttpError && error.status === 409) return null;
      throw error;
    }
  }

  const deleteSprite = (id, expression) => request(`/api/sprites/${enc(id)}/${enc(expression)}`, { method: "DELETE", headers: CSRF_ONLY });

  // ── Gallery ──

  const listGallery = (id) => getJson(`/api/characters/${enc(id)}/gallery`);

  /** Server-side download of up to 10 web images into the gallery: {results:[{url, file}|{url, error}]}. */
  const bakeGallery = (id, urls, bakedImages = []) => send("POST", `/api/characters/${enc(id)}/gallery/bake`, { urls, bakedImages });

  /** Multipart upload of bytes we already have. */
  async function uploadGallery(id, bytes, filename, mime) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), filename);
    return request(`/api/characters/${enc(id)}/gallery/upload`, { method: "POST", headers: CSRF_ONLY, body: form });
  }

  const deleteGalleryImage = (id, imageId) => request(`/api/characters/${enc(id)}/gallery/${enc(imageId)}`, { method: "DELETE", headers: CSRF_ONLY });
  const galleryFileUrl = (id, file) => `/api/characters/${enc(id)}/gallery/file/${enc(file)}`;

  async function readBytes(path) {
    const { bytes, contentType } = await ciNet.fetchLocal(path);
    return { bytes, contentType };
  }

  // ── Lorebooks ──

  const getLorebook = async (id) => {
    try {
      return await getJson(`/api/lorebooks/${enc(id)}`);
    } catch (error) {
      if (error instanceof ciNet.HttpError && error.status === 404) return null;
      throw error;
    }
  };
  const lorebooksForCharacter = (id) => getJson(`/api/lorebooks?characterId=${enc(id)}`);
  const listLorebooks = () => getJson("/api/lorebooks");
  const setLorebookCharacters = (id, characterIds) => send("PATCH", `/api/lorebooks/${enc(id)}`, { characterIds });

  /** Add a character to a lorebook's links. Returns true if it changed. */
  async function linkLorebook(lorebookId, characterId) {
    const book = await getLorebook(lorebookId);
    if (!book) return false;
    const ids = Array.isArray(book.characterIds) ? book.characterIds : book.characterId ? [book.characterId] : [];
    if (ids.includes(characterId)) return false;
    await setLorebookCharacters(lorebookId, [...ids, characterId]);
    return true;
  }

  /** @returns {Promise<{lorebookId: string, name: string, entriesImported: number}>} */
  async function importLorebook(json, filename) {
    const result = await send("POST", "/api/import/st-lorebook", { ...json, __filename: filename });
    if (!result?.success || !result.lorebookId) throw new ciNet.LocalSaveError(result?.error || "Marinara could not import the lorebook");
    return result;
  }

  // ── Chats and groups (for duplicate cleanup) ──

  const listChats = () => getJson("/api/chats");
  const listGroups = () => getJson("/api/characters/groups/list");

  // ── Marinara's React Query cache ──
  // Marinara emits no event when characters change and doesn't refetch on
  // focus, so new cards only show after its cache is invalidated. The
  // QueryClient is found on the root fiber (QueryClientProvider's props).

  let queryClient = null;
  function findQueryClient() {
    if (queryClient) return queryClient;
    const root = document.getElementById("root");
    if (!root) return null;
    const containerKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
    let fiber = containerKey ? root[containerKey] : null;
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.child) {
      const client = fiber.memoizedProps?.client;
      if (client && typeof client.invalidateQueries === "function") return (queryClient = client);
    }
    return null;
  }

  /** @param {("characters"|"sprites"|"lorebooks"|"gallery")[]} what @returns {boolean} whether the cache was found */
  function refreshMarinara(what = ["characters"]) {
    const client = findQueryClient();
    if (!client) return false;
    const roots = new Set(what);
    try {
      void client.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          if (!Array.isArray(key)) return false;
          if (roots.has(key[0])) return true;
          return roots.has("gallery") && key.some((part) => typeof part === "string" && part.includes("gallery"));
        },
      });
      return true;
    } catch (error) {
      marinara.log.warn("Could not refresh Marinara's lists", error);
      return false;
    }
  }

  return Object.freeze({
    request, parseRow,
    listCatalog, iterateCharacters, getCharacter, importCharacter, importCharacterFile, updateCharacter, deleteCharacter, bulkTags,
    exportCharacter, importMarinara, duplicates,
    listSprites, spriteCatalog, createSpriteFolder, uploadSprite, deleteSprite,
    listGallery, bakeGallery, uploadGallery, deleteGalleryImage, galleryFileUrl, readBytes,
    getLorebook, lorebooksForCharacter, listLorebooks, setLorebookCharacters, linkLorebook, importLorebook,
    listChats, listGroups,
    refreshMarinara,
  });
})();
