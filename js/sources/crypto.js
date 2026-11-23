// Crypto: the 30 largest coins by market cap (CoinGecko, no key) that trade against USDT on Binance.
// Prices and candles from Binance (no key, live WebSocket). If Binance can't be reached from this network,
// Coinbase Exchange (no key, live WebSocket) takes over. Instrument keys stay "crypto:BTCUSDT" either way.

import { getJSON, LiveSocket, SourceError } from "./http.js";

const CG = "https://api.coingecko.com/api/v3";
const BN_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const BN_WS = ["wss://data-stream.binance.vision/stream", "wss://stream.binance.com:9443/stream"];
const CB = "https://api.exchange.coinbase.com";
const CB_WS = "wss://ws-feed.exchange.coinbase.com";

const STABLE = new Set("usdt usdc usds usde dai fdusd tusd usdd usd1 rlusd usdg usdy pyusd gho frax lusd susd eurc usdtb bfusd susde buidl usdx usdb usdl usdp gusd usd0 usyc ustb usdf usdai crvusd".split(" "));
// Used only if CoinGecko does not answer; prices still come live from the exchange.
const FALLBACK_TOP = "BTC ETH XRP BNB SOL DOGE ADA TRX LINK AVAX XLM BCH SUI HBAR LTC DOT SHIB TON UNI NEAR APT ICP ETC AAVE PEPE TAO ONDO ARB FIL ATOM".split(" ");

const IVL_CB = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };

export function createCrypto({ onTick, onKline, onState }) {
  let mode = "binance", host = 0, wsHost = 0;
  let pairs = null;           // Set of tradable ids ("BTCUSDT")
  const meta = {};            // id → {sym, name, img}
  const want = new Set();     // ids streamed live
  let chart = null;           // {id, ivl} streamed klines (Binance only)
  let sock = null, subId = 1;

  const inst = id => {
    const sym = id.replace(/USDT$/, "");
    const m = meta[id] || {};
    return { key: "crypto:" + id, m: "crypto", id, sym, name: m.name || sym, img: m.img || "" };
  };

  async function bn(path) {
    let lastErr;
    for (let i = 0; i < BN_HOSTS.length; i++) {
      const h = (host + i) % BN_HOSTS.length;
      try { const d = await getJSON(BN_HOSTS[h] + path, { source: "binance" }); host = h; return d; }
      catch (e) { lastErr = e; if (e.kind === "offline") throw e; }
    }
    throw lastErr;
  }

  async function loadPairs() {
    if (pairs) return pairs;
    try {
      const all = await bn("/api/v3/ticker/price");
      pairs = new Set(all.map(x => x.symbol).filter(s => s.endsWith("USDT")));
    } catch (e) {
      if (e.kind === "offline") throw e;
      // Binance unreachable from here: switch to Coinbase for this session.
      const prods = await getJSON(CB + "/products", { source: "coinbase" });
      mode = "coinbase";
      pairs = new Set(prods.filter(p => p.quote_currency === "USD" && p.status === "online" && !p.trading_disabled).map(p => p.base_currency + "USDT"));
      onState?.({ mode });
    }
    return pairs;
  }

  /** The 30 largest non-stablecoins that can be traded live here. */
  async function top(n = 30) {
    await loadPairs();
    let list = [];
    let fromCG = true;
    try {
      const d = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=120&page=1`, { source: "coingecko" });
      for (const c of d) {
        const sym = String(c.symbol || "").toUpperCase();
        if (STABLE.has(c.symbol) || /usd|wrapped|staked|bridged/i.test(c.name) && !/^(BTC|ETH)$/.test(sym)) continue;
        const id = sym + "USDT";
        if (!pairs.has(id) || list.some(x => x.id === id)) continue;
        meta[id] = { sym, name: c.name, img: typeof c.image === "string" && c.image.startsWith("https://") ? c.image : "", rank: c.market_cap_rank, mc: c.market_cap };
        list.push(id);
        if (list.length >= n) break;
      }
    } catch (e) {
      if (e.kind === "offline") throw e;
      fromCG = false;
      list = FALLBACK_TOP.map(s => s + "USDT").filter(id => pairs.has(id)).slice(0, n);
    }
    return { insts: list.map(inst), fromCG, mode };
  }

  /** Search any coin tradable here by symbol. */
  async function find(q) {
    await loadPairs();
    const Q = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!Q) return [];
    const hits = [...pairs].filter(id => id.replace(/USDT$/, "").startsWith(Q));
    hits.sort((a, b) => (a === Q + "USDT" ? -1 : b === Q + "USDT" ? 1 : a.length - b.length));
    return hits.slice(0, 30).map(inst);
  }

  /** Current price and 24h change: [{id, px, ch24, vol, t}]. */
  async function tickers(ids) {
    if (!ids.length) return [];
    await loadPairs();
    ids = ids.filter(id => pairs.has(id));
    if (mode === "binance") {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const d = await bn("/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(ids.slice(i, i + 100))));
        for (const x of d) out.push({ id: x.symbol, px: +x.lastPrice, ch24: +x.priceChangePercent, vol: +x.quoteVolume, t: x.closeTime || Date.now() });
      }
      return out;
    }
    const d = await getJSON(CB + "/products/stats", { source: "coinbase" });
    return ids.map(id => {
      const s = d[id.replace(/USDT$/, "") + "-USD"]?.stats_24hour;
      if (!s) return null;
      const px = +s.last, o = +s.open;
      return { id, px, ch24: o ? (px / o - 1) * 100 : null, vol: +s.volume * px, t: Date.now() };
    }).filter(Boolean);
  }

  /** Real 1-hour change (Binance rolling window), {id: pct}. Coinbase mode: {}. */
  async function hourChange(ids) {
    if (mode !== "binance" || !ids.length) return {};
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const d = await bn("/api/v3/ticker?windowSize=1h&type=MINI&symbols=" + encodeURIComponent(JSON.stringify(ids.slice(i, i + 50))));
      for (const x of d) { const o = +x.openPrice, c = +x.lastPrice; if (o) out[x.symbol] = (c / o - 1) * 100; }
    }
    return out;
  }

  async function candles(id, ivl) {
    await loadPairs();
    if (mode === "binance") {
      const d = await bn(`/api/v3/klines?symbol=${encodeURIComponent(id)}&interval=${ivl}&limit=300`);
      return d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    }
    const prod = id.replace(/USDT$/, "") + "-USD";
    const d = await getJSON(`${CB}/products/${encodeURIComponent(prod)}/candles?granularity=${IVL_CB[ivl]}`, { source: "coinbase" });
    if (!Array.isArray(d)) throw new SourceError("coinbase", "http", "No candles");
    return d.map(r => ({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4] })).sort((a, b) => a.t - b.t);
  }

  // ---- live stream ----
  const bnStreams = () => [...[...want].map(id => id.toLowerCase() + "@miniTicker"), ...(chart ? [chart.id.toLowerCase() + "@kline_" + chart.ivl] : [])];

  function startSocket() {
    if (sock) return;
    if (mode === "binance") {
      sock = new LiveSocket({
        url: () => { const s = bnStreams(); return s.length ? BN_WS[wsHost] + "?streams=" + s.join("/") : null; },
        onMessage: m => {
          const d = m.data;
          if (!d) return;
          if (d.e === "24hrMiniTicker") { const o = +d.o, c = +d.c; onTick?.({ id: d.s, px: c, ch24: o ? (c / o - 1) * 100 : null, vol: +d.q, t: d.E }); }
          else if (d.e === "kline") onKline?.({ id: d.s, ivl: d.k.i, bar: { t: d.k.t, o: +d.k.o, h: +d.k.h, l: +d.k.l, c: +d.k.c } });
        },
        onState: (st, fastFails) => {
          if (st === "closed" && fastFails >= 3) { wsHost = (wsHost + 1) % BN_WS.length; sock.fastFails = 0; }
          onState?.({ ws: st });
        },
      }).start();
    } else {
      sock = new LiveSocket({
        url: CB_WS,
        onOpen: ws => ws.send(JSON.stringify({ type: "subscribe", product_ids: [...want].map(id => id.replace(/USDT$/, "-USD")), channels: ["ticker"] })),
        onMessage: m => {
          if (m.type !== "ticker" || !m.product_id) return;
          const id = m.product_id.replace(/-USD$/, "USDT"), px = +m.price, o = +m.open_24h;
          onTick?.({ id, px, ch24: o ? (px / o - 1) * 100 : null, vol: +m.volume_24h * px, t: Date.parse(m.time) || Date.now() });
        },
        onState: st => onState?.({ ws: st }),
      }).start();
    }
  }

  /** Stream these ids live (adds to what is already streamed). */
  async function watch(ids) {
    await loadPairs();
    const add = ids.filter(id => pairs.has(id) && !want.has(id));
    if (!add.length && sock) return;
    add.forEach(id => want.add(id));
    if (!sock) return startSocket();
    if (!sock.isOpen()) return; // reconnect will include them
    if (mode === "binance") sock.send({ method: "SUBSCRIBE", params: add.map(id => id.toLowerCase() + "@miniTicker"), id: subId++ });
    else sock.send({ type: "subscribe", product_ids: add.map(id => id.replace(/USDT$/, "-USD")), channels: ["ticker"] });
  }

  /** Live klines for the open chart (Binance). */
  function watchChart(id, ivl) {
    if (mode !== "binance") return false;
    const old = chart;
    chart = id ? { id, ivl } : null;
    if (sock?.isOpen()) {
      if (old) sock.send({ method: "UNSUBSCRIBE", params: [old.id.toLowerCase() + "@kline_" + old.ivl], id: subId++ });
      if (chart) sock.send({ method: "SUBSCRIBE", params: [id.toLowerCase() + "@kline_" + ivl], id: subId++ });
    } else if (chart) startSocket();
    return true;
  }

  return { top, find, tickers, hourChange, candles, watch, watchChart, inst, meta, get mode() { return mode; }, pause: () => sock?.stop(), resume: () => { if (sock) sock.start(); } };
}
