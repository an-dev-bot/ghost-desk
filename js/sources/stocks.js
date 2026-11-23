// US stocks: Finnhub (free key that the owner creates; stored only on the phone).
// REST: real-time quote, search, market status, holidays (60 calls/min on the free plan; we keep to 50).
// WebSocket: live trades for up to 50 symbols.
// Finnhub does not accept the key as a header from a browser (CORS preflight fails), so it travels in the
// request URL. That URL is never stored: not logged, not in errors, not cached by the service worker.

import { getJSON, LiveSocket, RateLimiter, SourceError } from "./http.js";

const BASE = "https://finnhub.io/api/v1";
const WS = "wss://ws.finnhub.io";

export const STOCKS_DEFAULT = [
  ["SPY", "S&P 500 (ETF SPY)"], ["QQQ", "Nasdaq 100 (ETF QQQ)"], ["AAPL", "Apple"], ["NVDA", "Nvidia"], ["TSLA", "Tesla"],
  ["MSFT", "Microsoft"], ["AMZN", "Amazon"], ["GOOGL", "Alphabet (Google)"], ["META", "Meta"], ["NFLX", "Netflix"],
  ["AMD", "AMD"], ["PLTR", "Palantir"], ["COIN", "Coinbase"], ["JPM", "JPMorgan"], ["V", "Visa"], ["KO", "Coca-Cola"],
  ["DIS", "Disney"], ["NKE", "Nike"], ["WMT", "Walmart"], ["BA", "Boeing"], ["UBER", "Uber"],
];
const NAMES = Object.fromEntries(STOCKS_DEFAULT);

export function stockInst(sym, name) {
  return { key: "stock:" + sym, m: "stock", id: sym, sym, name: name || NAMES[sym] || sym };
}

export function createFinnhub({ getKey, onTrade, onError }) {
  const lim = new RateLimiter(50, 60e3);
  const want = new Set();
  let sock = null;
  let lastAuthFail = 0;

  async function call(path, params = {}) {
    const key = getKey();
    if (!key) throw new SourceError("finnhub", "nokey", "Finnhub key missing");
    await lim.take();
    const qs = new URLSearchParams({ ...params, token: key });
    try {
      return await getJSON(`${BASE}${path}?${qs}`, { source: "finnhub" });
    } catch (e) {
      if (e.kind === "auth" && e.status === 403 && /access/i.test(e.body)) e.kind = "premium";
      if (e.kind === "auth") lastAuthFail = Date.now();
      onError?.(e);
      throw e;
    }
  }

  /** {px, prev, ch24, t, o, h, l} or null for an unknown symbol. */
  async function quote(sym) {
    const d = await call("/quote", { symbol: sym });
    if (!d || (!d.c && !d.t)) return null;
    return { px: d.c, prev: d.pc, ch24: d.dp, t: d.t * 1000, o: d.o, h: d.h, l: d.l };
  }

  async function search(q) {
    const d = await call("/search", { q, exchange: "US" });
    return (d?.result || [])
      .filter(r => r.symbol && !/[.:]/.test(r.symbol) && /Common Stock|ETP|ETF|ADR/i.test(r.type || ""))
      .slice(0, 25)
      .map(r => stockInst(r.symbol, titleCase(r.description) || r.symbol));
  }

  const status = () => call("/stock/market-status", { exchange: "US" });
  const holidays = () => call("/stock/market-holiday", { exchange: "US" });

  function startSocket() {
    if (sock || !getKey()) return;
    sock = new LiveSocket({
      url: () => (getKey() ? `${WS}?token=${encodeURIComponent(getKey())}` : null),
      onOpen: ws => { for (const s of want) ws.send(JSON.stringify({ type: "subscribe", symbol: s })); },
      onMessage: m => {
        if (m.type === "trade") {
          const last = {};
          for (const t of m.data || []) if (!last[t.s] || t.t >= last[t.s].t) last[t.s] = t;
          for (const s in last) onTrade?.({ id: s, px: last[s].p, t: last[s].t });
        } else if (m.type === "error") {
          onError?.(new SourceError("finnhub", /limit/i.test(m.msg || "") ? "limit" : "http", m.msg || "Live stream error"));
        }
      },
    }).start();
  }

  function watch(syms) {
    const add = syms.filter(s => !want.has(s));
    const room = 50 - want.size;
    for (const s of add.slice(0, Math.max(0, room))) {
      want.add(s);
      sock?.send({ type: "subscribe", symbol: s });
    }
    startSocket();
  }

  function reset() { sock?.stop(); sock = null; if (getKey()) startSocket(); }

  return {
    quote, search, status, holidays, watch, reset,
    free: () => lim.free(),
    hasKey: () => !!getKey(),
    authFailedRecently: () => Date.now() - lastAuthFail < 10 * 60e3,
    pause: () => sock?.stop(),
    resume: () => { if (sock) sock.start(); else startSocket(); },
  };
}

function titleCase(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Inc|Corp|Co|Ltd|Plc|Etf)\b\.?/g, m => m);
}
