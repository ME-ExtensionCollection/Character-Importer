// Char Importer: small IndexedDB key-value store for data too big for
// marinara.storage (1 MB): library index, import queue, image failures,
// asset links, gallery hashes and duplicate backups. All of it can be rebuilt
// or is a convenience copy; the source of truth stays on the cards.

const ciIdb = (() => {
  "use strict";

  const DB_NAME = "marinara-char-importer";
  const STORES = ["kv", "backups"];
  let dbPromise = null;

  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Char Importer storage is blocked by another tab"));
    });
    return dbPromise;
  }

  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  const get = (key, store = "kv") => run(store, "readonly", (s) => s.get(key));
  const set = (key, value, store = "kv") => run(store, "readwrite", (s) => s.put(value, key));
  const del = (key, store = "kv") => run(store, "readwrite", (s) => s.delete(key));
  const keys = (store = "kv") => run(store, "readonly", (s) => s.getAllKeys());

  /** Read-modify-write of one object-valued key. `fn` may mutate and/or return the new value. */
  let chain = Promise.resolve();
  function update(key, fn) {
    const next = chain.then(async () => {
      const current = (await get(key)) ?? {};
      const result = await fn(current);
      await set(key, result ?? current);
      return result ?? current;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  function close() {
    if (!dbPromise) return;
    dbPromise.then((db) => db.close(), () => undefined);
    dbPromise = null;
  }

  return Object.freeze({ get, set, del, keys, update, close });
})();
