// IndexedDB storage, only on this device. Two stores: "kv" (portfolio, achievements, settings, budgets)
// and "candles" (cached chart bars). Falls back to memory with a warning if IndexedDB is unavailable.

const DB = "ghost-desk", VER = 1;
let db = null, memory = null;

export async function openStore(name = DB) {
  if (db || memory) return !!db;
  try {
    db = await new Promise((res, rej) => {
      const r = indexedDB.open(name, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
        if (!d.objectStoreNames.contains("candles")) d.createObjectStore("candles");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    });
    return true;
  } catch {
    memory = { kv: new Map(), candles: new Map() };
    return false;
  }
}

function tx(store, mode, fn) {
  if (memory) return Promise.resolve(fn(null, memory[store]));
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let out;
    const r = fn(os, null);
    if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("abort"));
  });
}

const clone = v => (v === undefined ? undefined : structuredClone(v));

export const kv = {
  get: k => tx("kv", "readonly", (os, m) => (m ? clone(m.get(k)) : os.get(k))),
  set: (k, v) => tx("kv", "readwrite", (os, m) => (m ? void m.set(k, clone(v)) : os.put(v, k))),
  del: k => tx("kv", "readwrite", (os, m) => (m ? void m.delete(k) : os.delete(k))),
};
export const candles = {
  get: k => tx("candles", "readonly", (os, m) => (m ? clone(m.get(k)) : os.get(k))),
  set: (k, v) => tx("candles", "readwrite", (os, m) => (m ? void m.set(k, clone(v)) : os.put(v, k))),
  clear: () => tx("candles", "readwrite", (os, m) => (m ? void m.clear() : os.clear())),
};

export function usingMemory() { return !!memory; }

/** Close and delete a database (tests only). */
export async function destroyStore(name) {
  if (db) { db.close(); db = null; }
  memory = null;
  await new Promise(res => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}
