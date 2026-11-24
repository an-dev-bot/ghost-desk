// IndexedDB storage, only on this device. Two stores: "kv" (portfolio, achievements, settings, budgets)
// and "candles" (cached chart bars). Falls back to memory with a warning if IndexedDB is unavailable.

const DB = "ghost-desk", VER = 1;
const TRIES = 3, OPEN_MS = 4000, TX_MS = 8000;
let db = null, memory = null, dbName = DB, opening = null;

function openOnce() {
  return new Promise((res, rej) => {
    let late = false;
    const timer = setTimeout(() => { late = true; rej(new Error("The storage did not answer")); }, OPEN_MS);
    const r = indexedDB.open(dbName, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("candles")) d.createObjectStore("candles");
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      const d = r.result;
      if (late) { d.close(); return; }
      d.onclose = () => { if (db === d) db = null; }; // iOS drops the connection in the background: open it again
      res(d);
    };
    r.onerror = () => { clearTimeout(timer); rej(r.error); };
  });
}
/** Open (or reopen) the database. iOS sometimes fails or hangs the first time, so it tries more than once. */
function connect() {
  return (opening ||= (async () => {
    for (let n = 1; ; n++) {
      try { return (db = await openOnce()); }
      catch (e) { if (n >= TRIES) throw e; await new Promise(r => setTimeout(r, 200 * n)); }
    }
  })().finally(() => { opening = null; }));
}

export async function openStore(name = DB) {
  if (db || memory) return !!db;
  dbName = name;
  try { await connect(); return true; }
  catch {
    memory = { kv: new Map(), candles: new Map() };
    return false;
  }
}

/** One transaction. Resolves only when it is complete (on disk: "strict"), not when the request is accepted. */
function run(d, store, mode, fn) {
  return new Promise((res, rej) => {
    let t;
    try { t = d.transaction(store, mode, { durability: "strict" }); }
    catch (e) { e.dropped = true; throw e; } // the connection is gone
    const timer = setTimeout(() => { const e = new Error("The storage did not answer"); e.dropped = true; rej(e); }, TX_MS);
    let out;
    t.oncomplete = () => { clearTimeout(timer); res(out); };
    t.onabort = () => { clearTimeout(timer); rej(t.error || new Error("The save was interrupted")); };
    try {
      const r = fn(t.objectStore(store), null);
      if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      if (mode === "readwrite") t.commit?.();
    } catch (e) { clearTimeout(timer); try { t.abort(); } catch { /* already over */ } rej(e); }
  });
}
// With an open connection the request is issued synchronously, before any await (needed in pagehide).
async function tx(store, mode, fn) {
  if (memory) return fn(null, memory[store]);
  for (let n = 0; ; n++) {
    const d = db || await connect();
    try { return await run(d, store, mode, fn); }
    catch (e) {
      if (n || !(e?.dropped || ["UnknownError", "AbortError", "InvalidStateError"].includes(e?.name))) throw e;
      if (db === d) db = null;
      try { d.close(); } catch { /* already closed */ }
    }
  }
}

const clone = v => (v === undefined ? undefined : structuredClone(v));

export const kv = {
  get: k => tx("kv", "readonly", (os, m) => (m ? clone(m.get(k)) : os.get(k))),
  set: (k, v) => tx("kv", "readwrite", (os, m) => (m ? void m.set(k, clone(v)) : os.put(v, k))),
  /** Several values in one transaction: all of them are saved or none. entries: [[key, value]]; undefined deletes the key. */
  setMany: entries => tx("kv", "readwrite", (os, m) => {
    for (const [k, v] of entries) {
      if (v === undefined) m ? m.delete(k) : os.delete(k);
      else if (m) m.set(k, clone(v));
      else try { os.put(v, k); } catch (e) {
        if (e?.name !== "DataCloneError") throw e;
        os.put(JSON.parse(JSON.stringify(v)), k); // something in it can't be stored as it is: save the rest
      }
    }
  }),
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
