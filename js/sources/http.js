// Shared HTTP helpers for the price sources.
// Error messages never include the request URL (a Finnhub URL carries the key).

export class SourceError extends Error {
  /** kind: offline | net | auth | limit | premium | nokey | http | notfound */
  constructor(source, kind, message, status = 0, body = "") {
    super(message);
    this.source = source; this.kind = kind; this.status = status; this.body = body;
  }
}

let fetchImpl = (...a) => fetch(...a);
/** Tests replace fetch to serve hand-made prices and to inspect requested URLs. */
export function setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

export async function getJSON(url, { source = "?", headers, timeout = 12000 } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SourceError(source, "offline", "Offline");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetchImpl(url, { headers, signal: ctl.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    const off = typeof navigator !== "undefined" && navigator.onLine === false;
    throw new SourceError(source, off ? "offline" : "net", off ? "Offline" : "Could not connect");
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    let body = "";
    try { body = (await r.text()).slice(0, 300); } catch {}
    if (r.status === 401 || r.status === 403) throw new SourceError(source, "auth", "Rejected the key", r.status, body);
    if (r.status === 429) throw new SourceError(source, "limit", "Hit its request limit", r.status, body);
    if (r.status === 451) throw new SourceError(source, "net", "Not available in your region", r.status, body);
    if (r.status === 404) throw new SourceError(source, "notfound", "Not found", r.status, body);
    throw new SourceError(source, "http", "Answered with error " + r.status, r.status, body);
  }
  try { return await r.json(); } catch { throw new SourceError(source, "http", "Respuesta ilegible"); }
}

/** At most `n` calls per `windowMs`; extra calls wait their turn. */
export class RateLimiter {
  constructor(n, windowMs = 60e3) { this.n = n; this.w = windowMs; this.stamps = []; this.chain = Promise.resolve(); }
  take() {
    const run = async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter(t => now - t < this.w);
        if (this.stamps.length < this.n) { this.stamps.push(now); return; }
        await new Promise(r => setTimeout(r, this.w - (now - this.stamps[0]) + 20));
      }
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }
  /** Calls still free in the current window, without waiting. */
  free() { const now = Date.now(); return this.n - this.stamps.filter(t => now - t < this.w).length; }
}

/** WebSocket with automatic reconnect and backoff. */
export class LiveSocket {
  constructor({ url, onOpen, onMessage, onState }) {
    this.url = url; this.onOpen = onOpen; this.onMessage = onMessage; this.onState = onState || (() => {});
    this.ws = null; this.tries = 0; this.closed = false; this.timer = null; this.fastFails = 0;
  }
  start() { this.closed = false; this.connect(); return this; }
  connect() {
    if (this.closed) return;
    const url = typeof this.url === "function" ? this.url() : this.url;
    if (!url) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return this.retry(); }
    this.ws = ws;
    const opened = Date.now();
    ws.onopen = () => { this.tries = 0; this.onState("open"); this.onOpen?.(ws); };
    ws.onmessage = e => { try { this.onMessage(JSON.parse(e.data), ws); } catch {} };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.fastFails = Date.now() - opened < 3000 ? this.fastFails + 1 : 0;
      this.onState("closed", this.fastFails);
      this.retry();
    };
    ws.onerror = () => {};
  }
  retry() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const wait = Math.min(60e3, 1000 * 2 ** Math.min(this.tries++, 6));
    this.timer = setTimeout(() => this.connect(), wait);
  }
  send(obj) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  isOpen() { return this.ws?.readyState === 1; }
  stop() { this.closed = true; clearTimeout(this.timer); const ws = this.ws; this.ws = null; try { ws?.close(); } catch {} }
  restart() { this.stop(); this.start(); }
}
