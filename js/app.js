// Ghost Desk G1: fake money, real prices, four markets. Everything runs in the phone's browser.

import { FX_BY_ID, quoteBuy, quoteSell, halfSpread, MEME_FEE, CRYPTO_FEE, CRYPTO_SLIP } from "./core/money.js";
import * as H from "./core/hours.js";
import * as E from "./core/engine.js";
import { scoreboard, greenStreak, localDay, toCSV, MARKET_LABEL, realizedByDay } from "./core/stats.js";
import { ACHIEVEMENTS, newAchievements, evaluate, achievementById } from "./core/achievements.js";
import { applyTick, ticksToBars } from "./core/candles.js";
import { buildBackup, parseBackup, mergeAchievements } from "./core/backup.js";
import { openStore, kv, candles as candleStore, usingMemory } from "./store.js";
import { SourceError } from "./sources/http.js";
import * as dex from "./sources/dex.js";
import { createCrypto } from "./sources/crypto.js";
import { createFinnhub, STOCKS_DEFAULT, stockInst } from "./sources/stocks.js";
import { createTwelve, tdSymbol, DAILY_CAP } from "./sources/twelve.js";
import * as fx from "./sources/fx.js";
import { esc, usd, price, pct, dirCls, qty, countdown, ago, dateTime, clock, weekdayTime } from "./ui/format.js";
import { drawChart } from "./ui/chart.js";
import { confetti, shake, bigResult, vibrate, sounds } from "./ui/effects.js";
import { swipeHTML, bindSwipe, setSwipeEnabled } from "./ui/swipe.js";
import { notify, askPermission, notifySupport } from "./ui/notify.js";

const TEST = new URLSearchParams(location.search).get("test");
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const MARKETS = ["meme", "crypto", "stock", "fx"];
const FINNHUB_SIGNUP = "https://finnhub.io/register";
const TWELVE_SIGNUP = "https://twelvedata.com/register";

const DEFAULT_CFG = {
  finnhubKey: "", twelveKey: "", sound: false,
  notif: { fills: true, moves: true, price: true, summary: true, streak: true }, moveTh: 5,
  alerts: [], lastBuy: 100, chartMode: "candles", ivl: "5m", lastSummary: "", lastStreakDay: "",
};

// ---------------------------------------------------------------- state
let S, A, CFG;
const live = new Map();   // key → {inst, px, t, ch24, ch1h, liq, mc, vol, quoteUsd, dir, ...}
const ticks = new Map();  // key → [{t, px}] recorded while the app is open
const dirty = new Set();
const lists = { meme: { trending: [], nuevas: [] }, memeAt: { trending: 0, nuevas: 0 }, crypto: [], stock: [], fx: fx.FX_INSTS.map(i => i.key), search: { meme: null, crypto: null, stock: null, fx: null } };
const src = {};           // source → {ok, err, errAt}
const ui = { tab: "inicio", market: "crypto", memeView: "trending", hist: "all", histN: 100, sb: "all", sheet: null, query: { meme: "", crypto: "", stock: "", fx: "" }, searching: false };
let chart = null, chartToken = null, fxRef = null, fhStatus = null, installPrompt = null;
let cryptoNote = "";
const moveSent = {};
const nameOf = Object.fromEntries(STOCKS_DEFAULT);

// ---------------------------------------------------------------- sources
const crypto = createCrypto({
  onTick: d => setLive(crypto.inst(d.id), { px: d.px, ch24: d.ch24, vol: d.vol, t: d.t }),
  onKline: d => {
    if (chart && chart.key === "crypto:" + d.id && chart.ivl === d.ivl && chart.bars) {
      const b = chart.bars, last = b[b.length - 1];
      if (last && last.t === d.bar.t) b[b.length - 1] = d.bar; else if (!last || d.bar.t > last.t) b.push(d.bar);
      drawChartSoon();
    }
  },
  onState: s => { if (s.mode === "coinbase") cryptoNote = "Binance no responde desde tu red: cripto usa Coinbase."; if (s.ws === "open") okSrc(crypto.mode); },
});
const fh = createFinnhub({
  getKey: () => CFG.finnhubKey,
  onTrade: d => setLive(stockInst(d.id, nameOf[d.id] || live.get("stock:" + d.id)?.inst.name), { px: d.px, t: d.t }),
  onError: e => noteError(e),
});
const td = createTwelve({ getKey: () => CFG.twelveKey, budgetStore: kv, cache: candleStore, onError: e => noteError(e) });

function okSrc(name) {
  const had = src[name]?.err;
  src[name] = { ok: Date.now(), err: null };
  if (had) renderBanners();
}
function noteError(e) {
  if (!(e instanceof SourceError)) { console.warn("Ghost Desk:", e?.message || e); return; }
  const wasAuth = src[e.source]?.err?.kind === "auth";
  src[e.source] = { ...(src[e.source] || {}), err: e, errAt: Date.now() };
  renderBanners();
  if (e.kind === "auth" && !wasAuth && e.source === "finnhub") renderView();
}

// ---------------------------------------------------------------- live prices
function setLive(inst, d, { check = true } = {}) {
  const k = inst.key;
  let L = live.get(k);
  if (!L) { L = { inst: E.slimInst(inst) }; if (inst.url) L.inst.url = inst.url; if (inst.dp != null) L.inst.dp = inst.dp; live.set(k, L); }
  else for (const f of ["img", "name", "pair", "born", "url", "dp"]) if (inst[f] != null && inst[f] !== "") L.inst[f] = inst[f];
  const prev = L.px;
  for (const f in d) { const v = d[f]; if (v != null && !(typeof v === "number" && !isFinite(v))) L[f] = v; }
  if (d.px > 0) {
    const t = d.t || Date.now();
    if (prev > 0 && d.px !== prev) L.dir = d.px > prev ? 1 : -1;
    dirty.add(k);
    pushTick(k, t, d.px);
    if (chart && chart.key === k && chart.bars) { applyTick(chart.bars, chart.ivl, t, d.px); drawChartSoon(); }
  }
  if (check && d.px > 0) afterPrice(k);
  frame();
}

function pushTick(k, t, px) {
  let a = ticks.get(k);
  if (!a) ticks.set(k, (a = []));
  const last = a[a.length - 1];
  if (last && t < last.t) return;
  if (last && t - last.t < 2000) { last.px = px; last.t = t; } else a.push({ t, px });
  if (a.length > 4000) a.splice(0, a.length - 4000);
}

function quoteFor(key) {
  const L = live.get(key);
  if (!(L?.px > 0)) return null;
  return { px: L.px, t: L.t || Date.now(), liq: L.liq, quoteUsd: L.quoteUsd };
}

function instOf(key) {
  return live.get(key)?.inst || S.pos[key]?.inst || S.orders.find(o => o.key === key)?.inst || CFG.alerts.find(a => a.key === key)?.inst || null;
}

function mstatus(m, now = Date.now()) {
  return H.marketStatus(m, now);
}

function trackedKeys(m) {
  const set = new Set();
  for (const k in S.pos) set.add(k);
  for (const o of S.orders) set.add(o.key);
  for (const a of CFG.alerts) set.add(a.key);
  if (ui.sheet?.kind === "inst") set.add(ui.sheet.key);
  return [...set].filter(k => !m || k.startsWith(m + ":"));
}

function afterPrice(k) {
  runChecks(k);
  priceAlerts(k);
  moveAlert(k);
}

// ---------------------------------------------------------------- orders, stops, fills
function runChecks(k, now = Date.now()) {
  const p = S.pos[k], o = S.orders.find(x => x.key === k);
  if (!p && !o) return;
  const q = quoteFor(k);
  if (!q) return;
  const m = (p || o).inst.m;
  const events = E.checkKey(S, k, q, now, mstatus(m, now));
  if (events.length) handleEvents(events);
  else saveSoon(3000);
}

function handleEvents(events) {
  const trades = [];
  for (const e of events) {
    const t = e.trade;
    if (e.type === "fill") {
      trades.push(t);
      const kind = e.order.type === "limit" ? "Tu orden límite se llenó" : "Tu orden se llenó al abrir el mercado";
      const body = `${t.side === "buy" ? "Compraste" : "Vendiste"} ${t.sym} a ${fmtPx(instOf(t.key), t.px)} · ${usd(t.usd)}${t.side === "sell" ? " · " + usd(t.pl, { sign: true }) : ""}`;
      toast(kind + ": " + body, t.side === "sell" ? (t.pl >= 0 ? "up" : "down") : "");
      alertPhone("fills", kind, body, "fill-" + t.id);
    } else if (e.type === "sl" || e.type === "tp") {
      trades.push(t);
      const kind = e.type === "sl" ? "Tu stop loss se activó" : "Tu take profit se activó";
      const body = `Vendiste ${t.sym} a ${fmtPx(instOf(t.key), t.px)} · ${usd(t.pl, { sign: true })} (${pct(t.plPct * 100, 1)})`;
      toast(kind + ": " + body, t.pl >= 0 ? "up" : "down");
      alertPhone("fills", kind, body, "stop-" + t.id);
    } else if (e.type === "cancel") {
      toast(`Se canceló tu orden de ${e.order.inst.sym}: ${e.reason}`, "down");
    }
  }
  if (trades.length) {
    const lastSell = [...trades].reverse().find(t => t.side === "sell");
    celebrate(lastSell || trades[trades.length - 1]);
    afterTrades(trades);
  } else { saveSoon(); renderView(); renderSheet(); }
}

function afterTrades(trades) {
  const tot = E.totals(S, quoteFor).total;
  const st = H.stockStatus(Date.now());
  const got = evaluate(A, trades, { trades: S.trades, total: tot, now: Date.now(), stockOpenSince: st.open ? st.since : null });
  for (const id of got) {
    const a = achievementById(id);
    setTimeout(() => toast(`${a.icon} Logro: ${a.name}`, "gold"), 1400);
  }
  if (got.length) saveAch();
  saveSoon(0);
  streakCheck();
  renderView();
  renderSheet();
  frame();
}

function celebrate(t) {
  if (!t) return;
  if (t.side === "sell") {
    const win = t.pl >= 0;
    bigResult($("#result"), { text: usd(t.pl, { sign: true }), sub: `${t.sym} · ${pct(t.plPct * 100, 1)}`, win });
    if (win) { confetti($("#confetti")); vibrate([25, 40, 25, 40, 60]); if (CFG.sound) sounds.win(); }
    else { shake($("#app")); vibrate(220); if (CFG.sound) sounds.loss(); }
  } else {
    if (t.reason === "manual") toast(`Compraste ${usd(t.usd)} de ${t.sym}`, "up");
    vibrate(20);
    if (CFG.sound) sounds.fill();
  }
}

function alertPhone(kind, title, body, tag) {
  if (!CFG.notif[kind]) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return; // the toast already said it
  notify(title, body, { tag });
}

function priceAlerts(k) {
  const L = live.get(k);
  if (!CFG.alerts.length || !(L?.px > 0)) return;
  const hit = CFG.alerts.filter(a => a.key === k && (a.dir === "above" ? L.px >= a.price : L.px <= a.price));
  if (!hit.length) return;
  CFG.alerts = CFG.alerts.filter(a => !hit.includes(a));
  saveCfg();
  for (const a of hit) {
    const text = `${L.inst.sym} tocó ${fmtPx(L.inst, a.price)}`;
    toast("🔔 " + text, "gold");
    if (CFG.sound) sounds.fill();
    alertPhone("price", text, `Precio en vivo: ${fmtPx(L.inst, L.px)}`, "alert-" + a.id);
  }
  renderSheet();
}

function hourChange(k) {
  const L = live.get(k);
  if (L?.ch1h != null) return L.ch1h;
  const a = ticks.get(k);
  if (!a || a.length < 2) return null;
  const now = a[a.length - 1], target = now.t - 3600e3;
  if (a[0].t > target + 5 * 60e3) return null; // need ~an hour of real prices
  const base = a.find(x => x.t >= target);
  return base ? (now.px / base.px - 1) * 100 : null;
}

function moveAlert(k) {
  if (!CFG.notif.moves || !S.pos[k]) return;
  const ch = hourChange(k);
  if (ch == null || Math.abs(ch) < CFG.moveTh) return;
  const id = k + (ch > 0 ? "+" : "-");
  if (Date.now() - (moveSent[id] || 0) < 3600e3) return;
  moveSent[id] = Date.now();
  const L = live.get(k);
  const text = `${L.inst.sym} ${ch > 0 ? "subió" : "bajó"} ${Math.abs(ch).toFixed(1)}% en 1 hora`;
  toast((ch > 0 ? "📈 " : "📉 ") + text, ch > 0 ? "up" : "down");
  alertPhone("moves", text, `Ahora ${fmtPx(L.inst, L.px)}. Tienes una posición abierta.`, "move-" + k);
}

function streakCheck() {
  const now = Date.now(), today = localDay(now);
  if (CFG.lastStreakDay === today) return;
  const real = realizedByDay(S.trades)[today];
  const n = greenStreak(S.trades, now);
  if (real > 0 && n >= 2) {
    CFG.lastStreakDay = today; saveCfg();
    const text = `Llevas ${n} días en verde 🔥`;
    setTimeout(() => toast(text, "gold"), 2600);
    alertPhone("streak", text, "Sigue así: cierra hoy en verde otra vez mañana.", "streak");
  }
}

function dailySummary(now) {
  if (!S.trades.length && !Object.keys(S.pos).length) return;
  const p = H.nyParts(now);
  const sess = H.stockSessionFor(p.y, p.mo, p.d);
  const key = H.ymd(p.y, p.mo, p.d);
  if (!sess || now < sess.close || CFG.lastSummary === key) return;
  if (now - sess.close > 8 * 3600e3) return; // too late to call it "al cierre"
  CFG.lastSummary = key; saveCfg();
  const tot = E.totals(S, quoteFor).total;
  const day = S.days[localDay(now)];
  const todayTrades = S.trades.filter(t => localDay(t.t) === localDay(now));
  const real = todayTrades.reduce((a, t) => a + (t.side === "sell" ? t.pl : 0), 0);
  const text = `Tu cartera vale ${usd(tot)}` + (day ? ` (${usd(tot - day.first, { sign: true })} desde las ${clock(day.firstT)})` : "") +
    ` · ${todayTrades.length} operaciones hoy · realizado ${usd(real, { sign: true })}`;
  toast("🔔 Cierre de Wall Street. " + text);
  alertPhone("summary", "Resumen al cierre", text, "summary");
}

// ---------------------------------------------------------------- persistence
let saveTimer = null;
function saveSoon(ms = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, ms);
}
async function flushSave() {
  clearTimeout(saveTimer);
  try { await kv.set("portfolio", S); } catch (e) { console.warn("No se pudo guardar", e?.message); }
}
const saveAch = () => kv.set("achievements", A).catch(() => {});
const saveCfg = () => kv.set("settings", CFG).catch(() => {});

// ---------------------------------------------------------------- loops
const loops = {};
function loop(name, fn, visibleMs, hiddenMs) {
  const L = (loops[name] = { busy: false, again: false, timer: null });
  L.run = async () => {
    clearTimeout(L.timer);
    if (L.busy) { L.again = true; return; }
    L.busy = true;
    try { await fn(); } catch (e) { noteError(e); }
    L.busy = false;
    if (L.again) { L.again = false; return L.run(); }
    L.timer = setTimeout(L.run, document.hidden ? hiddenMs : visibleMs);
  };
  L.run();
}
const kick = name => loops[name]?.run();

async function memeLoop() {
  const need = new Set(trackedKeys("meme"));
  const showing = ui.tab === "inicio" || (ui.tab === "mercados" && ui.market === "meme");
  if (showing && !document.hidden) {
    const view = ui.tab === "inicio" ? "trending" : ui.memeView;
    if (!lists.meme[view].length || Date.now() - lists.memeAt[view] > 90e3) await loadMemeList(view);
    else lists.meme[view].forEach(k => need.add(k));
    (lists.search.meme || []).forEach(k => need.add(k));
  }
  const addrs = [...need].map(k => k.slice(5));
  if (!addrs.length) return;
  const toks = await dex.tokens(addrs);
  okSrc("dexscreener");
  toks.forEach(applyMeme);
}
function applyMeme(t) {
  setLive(t, { px: t.px, t: Date.now(), liq: t.liq, mc: t.mc, vol: t.vol, ch24: t.ch.h24, ch1h: t.ch.h1, ch5m: t.ch.m5, ch6h: t.ch.h6 });
}
async function loadMemeList(view) {
  const toks = view === "trending" ? await dex.trending() : await dex.newest();
  okSrc("dexscreener");
  lists.meme[view] = toks.map(t => t.key);
  lists.memeAt[view] = Date.now();
  toks.forEach(applyMeme);
  if (ui.tab === "mercados" && ui.market === "meme" || ui.tab === "inicio") renderView();
}

let cryptoTopAt = 0;
async function cryptoLoop() {
  if (!lists.crypto.length || Date.now() - cryptoTopAt > 15 * 60e3) {
    const r = await crypto.top(30);
    if (r.fromCG) okSrc("coingecko"); else noteError(new SourceError("coingecko", "http", "CoinGecko no respondió"));
    lists.crypto = r.insts.map(i => i.key);
    r.insts.forEach(i => setLive(i, {}, { check: false }));
    cryptoTopAt = Date.now();
    renderView();
  }
  const ids = [...new Set([...lists.crypto, ...trackedKeys("crypto"), ...(lists.search.crypto || [])].map(k => k.slice(7)))];
  const t = await crypto.tickers(ids);
  okSrc(crypto.mode);
  for (const x of t) setLive(crypto.inst(x.id), x);
  crypto.watch(ids).catch(noteError);
}
async function cryptoHourLoop() {
  const ids = trackedKeys("crypto").filter(k => S.pos[k]).map(k => k.slice(7));
  if (!ids.length) return;
  const ch = await crypto.hourChange(ids);
  for (const id in ch) { const L = live.get("crypto:" + id); if (L) { L.ch1h = ch[id]; moveAlert("crypto:" + id); } }
}

let stockListAt = 0, statusAt = 0, holidaysAt = 0;
async function stockLoop() {
  if (!fh.hasKey()) return;
  const now = Date.now();
  if (!lists.stock.length) lists.stock = STOCKS_DEFAULT.map(([s, n]) => stockInst(s, n).key);
  if (now - holidaysAt > 24 * 3600e3) {
    holidaysAt = now;
    try { const h = await fh.holidays(); H.addHolidays(h?.data); } catch (e) { if (e.kind !== "premium") throw e; }
  }
  if (now - statusAt > 5 * 60e3) {
    statusAt = now;
    try {
      fhStatus = { ...(await fh.status()), t: now };
      if (fhStatus.holiday && !fhStatus.isOpen) { const p = H.nyParts(now); H.addHolidays([{ atDate: H.ymd(p.y, p.mo, p.d), eventName: fhStatus.holiday, tradingHour: "" }]); }
      okSrc("finnhub");
    } catch (e) { if (e.kind !== "premium") throw e; }
  }
  const open = H.stockStatus(now).open;
  const listDue = now - stockListAt > (open ? 3 : 30) * 60e3 && (ui.tab === "inicio" || ui.tab === "mercados");
  const keys = new Set(trackedKeys("stock"));
  if (listDue) { lists.stock.forEach(k => keys.add(k)); stockListAt = now; }
  (lists.search.stock || []).slice(0, 8).forEach(k => { if (!live.get(k)?.px) keys.add(k); });
  for (const k of keys) {
    try { await stockQuote(k.slice(6)); }
    catch (e) { if (["auth", "limit", "offline", "nokey", "net"].includes(e.kind)) throw e; } // one bad symbol doesn't stop the rest
  }
  fh.watch([...lists.stock, ...trackedKeys("stock")].map(k => k.slice(6)));
  if (listDue) renderView();
}
async function stockQuote(sym) {
  const q = await fh.quote(sym);
  okSrc("finnhub");
  if (!q) return null;
  setLive(stockInst(sym, nameOf[sym] || live.get("stock:" + sym)?.inst.name), { px: q.px, t: q.t, ch24: q.ch24, prev: q.prev, o: q.o, hi: q.h, lo: q.l });
  return q;
}

async function fxLoop() {
  const r = await fx.rates();
  okSrc("coinbase-fx");
  for (const inst of fx.FX_INSTS) {
    const q = fx.pairQuote(inst.id, r.rates);
    if (!q) continue;
    let ch24 = null;
    if (fxRef) { const ref = fx.pairQuote(inst.id, fxRef.rates); if (ref) ch24 = (q.px / ref.px - 1) * 100; }
    setLive(inst, { px: q.px, quoteUsd: q.quoteUsd, t: r.t, ch24 });
  }
}
async function fxRefLoad() {
  const y = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const cached = await kv.get("fx.ref");
  if (cached?.date === y) { fxRef = cached; return; }
  const rates = await fx.ratesOn(y);
  if (Object.keys(rates).length > 3) { fxRef = { date: y, rates }; kv.set("fx.ref", fxRef); }
}

function startSources() {
  loop("fx", fxLoop, 20e3, 90e3);
  fxRefLoad().then(() => kick("fx")).catch(noteError);
  loop("crypto", cryptoLoop, 30e3, 120e3);
  loop("cryptoHour", cryptoHourLoop, 120e3, 300e3);
  loop("meme", memeLoop, 10e3, 60e3);
  loop("stock", stockLoop, 60e3, 180e3);
  loop("clock", clockTick, 30e3, 60e3);
}

function clockTick() {
  const now = Date.now();
  const tot = E.totals(S, quoteFor);
  E.recordDay(S, localDay(now), tot.total, now);
  const got = evaluate(A, [], { trades: S.trades, total: tot.total, now, stockOpenSince: null });
  for (const id of got) { const a = achievementById(id); toast(`${a.icon} Logro: ${a.name}`, "gold"); }
  if (got.length) saveAch();
  dailySummary(now);
  saveSoon(1000);
}

// Market open/close transitions: re-check waiting orders the moment the bell rings.
let wasOpen = {};
function secondTick() {
  const now = Date.now();
  for (const m of ["stock", "fx"]) {
    const open = mstatus(m, now).open;
    if (wasOpen[m] !== undefined && open !== wasOpen[m]) {
      if (open && m === "stock") { statusAt = 0; kick("stock"); }
      if (open && m === "fx") kick("fx");
      renderView(); renderSheet();
    }
    wasOpen[m] = open;
  }
  for (const el of $$("[data-cd]")) {
    const left = +el.dataset.cd - now;
    el.textContent = countdown(left);
    if (left <= 0 && !el.dataset.done) { el.dataset.done = 1; setTimeout(() => { renderView(); renderSheet(); }, 1200); }
  }
  for (const el of $$("[data-age]")) el.textContent = ago(+el.dataset.age, now);
  if (ui.tab === "inicio") { updateLastChance(now); updateMovers(now); }
  renderTape();
}

// ---------------------------------------------------------------- formatting helpers
function fmtPx(inst, px) {
  if (!inst) return price(px);
  if (inst.m === "fx") return price(px, inst.dp ?? FX_BY_ID[inst.id]?.dp ?? 5);
  return price(px);
}
function icon(inst) {
  if (inst.img) return `<img class="ico" src="${esc(inst.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  const t = inst.m === "fx" ? inst.base : (inst.sym || "?").slice(0, 4);
  return `<span class="ico ico-${inst.m}" aria-hidden="true">${esc(t)}</span>`;
}
const offline = () => navigator.onLine === false;

function chHTML(key) {
  const L = live.get(key);
  if (offline()) return `<small class="flat">sin conexión</small>`;
  const v = L?.ch24;
  return `<small data-c="${esc(key)}" class="${dirCls(v)}">${pct(v)}</small>`;
}
function subFor(inst) {
  const L = live.get(inst.key) || {};
  if (inst.m === "meme") return `MC ${usd(L.mc, { compact: true })} · Liq ${usd(L.liq, { compact: true })}${inst.born ? ` · <span data-age="${inst.born}">${ago(inst.born)}</span>` : ""}`;
  if (inst.m === "crypto") return esc(inst.name) + (L.vol ? ` · Vol ${usd(L.vol, { compact: true })}` : "");
  return esc(inst.name);
}
function rowHTML(inst) {
  const L = live.get(inst.key);
  return `<button class="row" data-open="${esc(inst.key)}">
    ${icon(inst)}
    <span class="nm"><b>${esc(inst.sym)}</b><small>${subFor(inst)}</small></span>
    <span class="px"><b data-p="${esc(inst.key)}">${L?.px > 0 ? fmtPx(inst, L.px) : "—"}</b>${chHTML(inst.key)}</span>
  </button>`;
}

// ---------------------------------------------------------------- header, tape, banners
let lastTotal = null;
function updateHeader() {
  const now = Date.now();
  const t = E.totals(S, quoteFor);
  const el = $("#total");
  el.textContent = usd(t.total);
  if (lastTotal != null && Math.abs(t.total - lastTotal) > 0.004) flash(el, t.total > lastTotal ? 1 : -1);
  lastTotal = t.total;
  const day = S.days[localDay(now)];
  const dd = day ? t.total - day.first : null;
  const tp = $("#totalPl");
  tp.innerHTML = `<span class="${dirCls(t.pl)}">${usd(t.pl, { sign: true })} (${pct(t.plPct * 100)})</span> desde $10,000` +
    (dd != null && Math.abs(dd) >= 0.01 ? ` · <span class="${dirCls(dd)}">${usd(dd, { sign: true })} hoy</span>` : "");
  const ok = Object.values(src).some(s => s.ok && now - s.ok < 90e3);
  const dot = $("#liveDot");
  dot.className = "live " + (offline() ? "off" : ok ? "on" : "wait");
  dot.textContent = offline() ? "Sin conexión" : ok ? "En vivo" : "Conectando";
}

function flash(el, dir) {
  if (!dir) return;
  el.classList.remove("fl-up", "fl-down"); void el.offsetWidth;
  el.classList.add(dir > 0 ? "fl-up" : "fl-down");
}

function updateDirty() {
  for (const k of dirty) {
    const L = live.get(k);
    if (!L) continue;
    const sel = CSS.escape(k);
    for (const el of document.querySelectorAll(`[data-p="${sel}"]`)) {
      const txt = fmtPx(L.inst, L.px);
      if (el.textContent !== txt) { el.textContent = txt; flash(el, L.dir); }
    }
    for (const el of document.querySelectorAll(`[data-c="${sel}"]`)) { el.textContent = pct(L.ch24); el.className = dirCls(L.ch24); }
    const p = S.pos[k];
    if (p) {
      const v = E.positionView(p, quoteFor(k));
      for (const el of document.querySelectorAll(`[data-v="${sel}"]`)) el.textContent = usd(v.value);
      for (const el of document.querySelectorAll(`[data-pl="${sel}"]`)) { el.textContent = `${usd(v.pl, { sign: true })} (${pct(v.plPct * 100, 1)})`; el.className = dirCls(v.pl); }
    }
  }
  dirty.clear();
}

let tapeAt = 0;
function renderTape(force) {
  if (!force && Date.now() - tapeAt < 20e3) return;
  tapeAt = Date.now();
  const per = MARKETS.map(m => [...live.values()].filter(L => L.inst.m === m && L.px > 0 && L.ch24 != null && isFinite(L.ch24)).sort((a, b) => Math.abs(b.ch24) - Math.abs(a.ch24)).slice(0, 5));
  const movers = [];
  for (let i = 0; i < 5; i++) for (const list of per) if (list[i]) movers.push(list[i]);
  const el = $("#tape");
  if (!movers.length) { el.innerHTML = `<span class="tk mut">Esperando precios en vivo…</span>`; el.style.animationDuration = "0s"; return; }
  const one = movers.map(L => `<button class="tk" data-open="${esc(L.inst.key)}"><b>${esc(L.inst.sym)}</b> <span data-c="${esc(L.inst.key)}" class="${dirCls(L.ch24)}">${pct(L.ch24, 1)}</span></button>`).join("");
  el.innerHTML = `<div class="tape-run">${one}</div><div class="tape-run" aria-hidden="true">${one}</div>`;
  el.style.animationDuration = Math.max(20, movers.length * 3.2) + "s";
}

const SRC_NAME = { dexscreener: "DexScreener", geckoterminal: "GeckoTerminal", binance: "Binance", coinbase: "Coinbase", coingecko: "CoinGecko", finnhub: "Finnhub", twelvedata: "Twelve Data", "coinbase-fx": "Coinbase (divisas)" };
function renderBanners() {
  const out = [];
  const now = Date.now();
  if (offline()) out.push(["warn", "Sin conexión: ves tu cartera y tu historial con los últimos precios guardados. Las órdenes se revisan en cuanto vuelva el internet."]);
  if (usingMemory()) out.push(["warn", "Este navegador no deja guardar datos en el teléfono (¿modo privado?). Exporta tu cartera en Ajustes antes de cerrar."]);
  const f = src.finnhub?.err;
  if (CFG.finnhubKey && f && !offline()) {
    if (f.kind === "auth") out.push(["err", `Finnhub rechazó tu clave. Revísala en <button class="lnk" data-settings>Ajustes</button>. Las acciones usan el último precio guardado.`]);
    else if (f.kind === "limit" && now - src.finnhub.errAt < 120e3) out.push(["warn", "Finnhub llegó a su límite de peticiones por minuto. Los precios de acciones siguen en cuanto se libere (menos de un minuto)."]);
  }
  if (!CFG.finnhubKey && Object.values(S.pos).some(p => p.inst.m === "stock")) {
    out.push(["warn", `Tienes acciones pero falta tu clave de Finnhub: su valor es el último precio guardado. <button class="lnk" data-settings>Poner clave</button>`]);
  }
  const t = src.twelvedata?.err;
  if (CFG.twelveKey && t && !offline()) {
    if (t.kind === "auth") out.push(["err", `Twelve Data rechazó tu clave. Revísala en <button class="lnk" data-settings>Ajustes</button>. Mientras, las gráficas usan precios en vivo.`]);
    else if (t.kind === "limit" && t.body === "day") out.push(["warn", "Se acabaron las velas de hoy de Twelve Data (800 al día). Las gráficas de acciones y divisas usan precios en vivo hasta mañana."]);
  }
  if (!offline()) {
    for (const name of ["dexscreener", "binance", "coinbase", "coinbase-fx"]) {
      const s = src[name];
      if (s?.err && now - s.errAt < 180e3 && (!s.ok || s.ok < s.errAt)) out.push(["warn", `No llegan precios de ${SRC_NAME[name]} (${esc(s.err.message.toLowerCase())}). Reintentando…`]);
    }
  }
  if (cryptoNote) out.push(["info", cryptoNote]);
  $("#banners").innerHTML = out.map(([k, h]) => `<div class="banner ${k}" role="status">${h}</div>`).join("");
}

// ---------------------------------------------------------------- views
function renderView() {
  const v = $("#view");
  const scroll = window.scrollY;
  const focused = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;
  if (ui.tab === "inicio") v.innerHTML = viewInicio();
  else if (ui.tab === "mercados") v.innerHTML = viewMercados();
  else if (ui.tab === "cartera") v.innerHTML = viewCartera();
  else if (ui.tab === "historial") v.innerHTML = viewHistorial();
  else if (ui.tab === "logros") v.innerHTML = viewLogros();
  if (focused) { const el = document.getElementById(focused); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
  window.scrollTo(0, scroll);
  for (const b of $$("nav.tabs button")) b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false");
  renderTape();
}

function marketCards(now) {
  const st = mstatus("stock", now), fs = mstatus("fx", now);
  const reason = { pre: "Antes de la apertura", post: "Ya cerró por hoy", weekend: "Fin de semana", holiday: "Feriado" + (st.holiday ? ": " + st.holiday : "") };
  const ws = st.open
    ? `<div class="cd-card open"><small>Wall Street abierto${st.early ? " · cierre temprano" : ""}</small><span>Cierra en</span><b data-cd="${st.closesAt}">${countdown(st.closesAt - now)}</b></div>`
    : `<div class="cd-card"><small>${esc(reason[st.reason] || "Cerrado")}</small><span>Wall Street abre en</span><b data-cd="${st.nextOpen}">${countdown(st.nextOpen - now)}</b><small>${esc(weekdayTime(st.nextOpen))} tu hora</small></div>`;
  const fxc = fs.open
    ? `<div class="cd-card open"><small>Divisas abierto</small><span>Cierra el viernes en</span><b data-cd="${fs.closesAt}">${countdown(fs.closesAt - now)}</b></div>`
    : `<div class="cd-card"><small>Divisas cerrado</small><span>Abre el domingo en</span><b data-cd="${fs.nextOpen}">${countdown(fs.nextOpen - now)}</b></div>`;
  return `<div class="cd-row">${ws}${fxc}</div><div class="cd-strip"><span class="dot"></span>Cripto y memecoins: abiertos 24/7</div>`;
}

function lastChances(now) {
  const out = [];
  const st = mstatus("stock", now), fs = mstatus("fx", now);
  const ord = m => S.orders.filter(o => o.inst.m === m).length;
  const pos = m => Object.values(S.pos).filter(p => p.inst.m === m).length;
  if (st.open && st.closesAt - now <= 15 * 60e3 && (ord("stock") || pos("stock"))) {
    out.push({ title: "Wall Street cierra en", cd: st.closesAt, text: `${ord("stock")} órdenes abiertas · ${pos("stock")} posiciones en acciones` });
  }
  if (fs.open && fs.closesAt - now <= 60 * 60e3 && (ord("fx") || pos("fx"))) {
    out.push({ title: "Divisas cierra el fin de semana en", cd: fs.closesAt, text: `${ord("fx")} órdenes abiertas · ${pos("fx")} posiciones en divisas` });
  }
  for (const o of S.orders) {
    if (o.type !== "limit") continue;
    const q = quoteFor(o.key);
    if (!q || !mstatus(o.inst.m, now).open) continue;
    const dist = Math.abs(q.px - o.limit) / o.limit;
    if (dist <= 0.005) out.push({ title: `Tu orden límite de ${o.inst.sym} está a ${(dist * 100).toFixed(2)}% de llenarse`, text: `Precio ${fmtPx(o.inst, q.px)} · límite ${fmtPx(o.inst, o.limit)}`, key: o.key });
  }
  const seen = new Set();
  for (const k of [...lists.meme.nuevas, ...lists.meme.trending]) {
    const L = live.get(k);
    if (seen.has(k) || !L?.inst.born || now - L.inst.born > 15 * 60e3 || now < L.inst.born) continue;
    seen.add(k);
    out.push({ title: `${L.inst.sym} es nueva`, text: `Nació hace <span data-age="${L.inst.born}">${ago(L.inst.born, now)}</span> · liquidez ${usd(L.liq, { compact: true })}`, key: k });
    if (seen.size >= 3) break;
  }
  return out;
}
function lastChanceHTML(now) {
  const lc = lastChances(now);
  if (!lc.length) return "";
  return `<section class="lc"><h2>Última oportunidad</h2>${lc.map(x => `
    <${x.key ? `button data-open="${esc(x.key)}"` : "div"} class="lc-card">
      <b>${esc(x.title)}${x.cd ? ` <span class="cd" data-cd="${x.cd}">${countdown(x.cd - now)}</span>` : ""}</b>
      <small>${x.text}</small>
    </${x.key ? "button" : "div"}>`).join("")}</section>`;
}
let lcSig = "";
function updateLastChance(now) {
  const sig = lastChances(now).map(x => x.title).join("|");
  if (sig !== lcSig) { lcSig = sig; const el = $("#lcSlot"); if (el) el.innerHTML = lastChanceHTML(now); }
}

function moversFor(m, n = 3) {
  const keys = m === "meme" ? lists.meme.trending : lists[m];
  return keys.map(k => live.get(k)).filter(L => L?.px > 0 && L.ch24 != null).sort((a, b) => Math.abs(b.ch24) - Math.abs(a.ch24)).slice(0, n).map(L => L.inst);
}

function viewInicio() {
  const now = Date.now();
  lcSig = lastChances(now).map(x => x.title).join("|");
  const streak = greenStreak(S.trades, now);
  const unlocked = Object.keys(A.unlocked).length;
  const todayTrades = S.trades.filter(t => localDay(t.t) === localDay(now)).length;
  const welcome = !S.trades.length ? `<div class="hello"><b>Tienes $10,000 de dinero falso.</b> Los precios son reales y en vivo. Elige un mercado, compra en dos toques y desliza para confirmar.</div>` : "";
  const orders = S.orders.length ? `<section><h2>Órdenes esperando (${S.orders.length})</h2><div class="list">${S.orders.map(orderRow).join("")}</div></section>` : "";
  moversSig = moversSignature(); moversAt = now;
  return `${welcome}${marketCards(now)}<div id="lcSlot">${lastChanceHTML(now)}</div>
    <div class="stat-row">
      <div><small>Racha en verde</small><b>${streak ? "🔥 " + streak + (streak === 1 ? " día" : " días") : "—"}</b></div>
      <div><small>Operaciones hoy</small><b>${todayTrades}</b></div>
      <div><small>Logros</small><b>${unlocked}/${ACHIEVEMENTS.length}</b></div>
    </div>
    ${orders}
    <h2>Lo que más se mueve (24 h)</h2><div id="moversSlot">${moversHTML()}</div>`;
}

// The movers block refreshes itself when the instruments in it change (not on every tick).
let moversSig = "", moversAt = 0;
function moversSignature() { return MARKETS.map(m => moversFor(m).map(i => i.key).sort().join(",")).join("|"); }
function moversHTML() {
  return MARKETS.map(m => {
    if (m === "stock" && !CFG.finnhubKey) return `<section class="mv"><h3>${MARKET_LABEL[m]}</h3>${noKeyCard()}</section>`;
    if (m === "stock" && src.finnhub?.err?.kind === "auth") return `<section class="mv"><h3>${MARKET_LABEL[m]}</h3>${badKeyCard()}</section>`;
    const list = moversFor(m);
    return `<section class="mv"><h3>${MARKET_LABEL[m]} <button class="lnk" data-market="${m}">ver todo</button></h3>
      <div class="list">${list.length ? list.map(rowHTML).join("") : `<div class="empty sm">Cargando precios en vivo…</div>`}</div></section>`;
  }).join("");
}
function updateMovers(now) {
  const slot = $("#moversSlot");
  if (!slot) return;
  const sig = moversSignature();
  if (sig === moversSig) return;
  const hadEmpty = moversSig.split("|").some(x => !x);
  if (now - moversAt < (hadEmpty ? 2e3 : 15e3)) return;
  moversSig = sig; moversAt = now;
  slot.innerHTML = moversHTML();
}

function badKeyCard() {
  return `<div class="nokey bad"><b>Finnhub rechazó tu clave</b>
    <p>Revisa que la copiaste completa desde tu panel de <a href="https://finnhub.io/dashboard" target="_blank" rel="noopener">finnhub.io</a> y vuelve a pegarla en Ajustes.</p>
    <button class="btn" data-settings>Ir a Ajustes</button></div>`;
}
function noKeyCard() {
  return `<div class="nokey"><b>Pon tu clave de Finnhub en Ajustes</b>
    <p>Las acciones necesitan una clave gratis de Finnhub. Créala en <a href="${FINNHUB_SIGNUP}" target="_blank" rel="noopener">finnhub.io/register</a> y pégala en Ajustes; se guarda solo en este teléfono.</p>
    <button class="btn" data-settings>Ir a Ajustes</button></div>`;
}

function viewMercados() {
  const m = ui.market;
  const seg = MARKETS.map(x => `<button data-market="${x}" aria-pressed="${x === m}">${MARKET_LABEL[x]}</button>`).join("");
  const ph = { meme: "Nombre, símbolo o dirección de Solana", crypto: "Símbolo: BTC, PEPE…", stock: "Símbolo o nombre: AAPL, Nvidia…", fx: "Par: EUR, MXN, JPY…" }[m];
  let body;
  if (m === "stock" && !CFG.finnhubKey) body = noKeyCard();
  else if (m === "stock" && src.finnhub?.err?.kind === "auth") body = badKeyCard();
  else {
    const res = lists.search[m];
    let keys, head = "";
    if (res) {
      keys = res;
      head = `<div class="res-head">Resultados para «${esc(ui.query[m])}» <button class="lnk" data-clear>Quitar búsqueda</button></div>`;
    } else if (m === "meme") keys = lists.meme[ui.memeView];
    else keys = lists[m];
    const sub = m === "meme" && !res ? `<div class="seg sub">${["trending", "nuevas"].map(v => `<button data-memeview="${v}" aria-pressed="${ui.memeView === v}">${v === "trending" ? "Trending" : "Nuevas"}</button>`).join("")}</div>` : "";
    const rows = keys.map(k => live.get(k)?.inst || instOf(k)).filter(Boolean).map(rowHTML).join("");
    body = sub + head + `<div class="list">${rows || `<div class="empty">${ui.searching ? "Buscando…" : res ? "Sin resultados." : "Cargando precios en vivo…"}</div>`}</div>`;
  }
  const foot = {
    meme: `Precios de DexScreener (Solana) cada 10 s, velas de GeckoTerminal. Comisión 1% + impacto según la liquidez.`,
    crypto: `Las 30 más grandes por capitalización (CoinGecko, sin stablecoins). Precios en vivo de ${crypto.mode === "coinbase" ? "Coinbase" : "Binance"}. Comisión 0.1% + 0.02% de deslizamiento.`,
    stock: `Precios en tiempo real de Finnhub. Comisión $0; pagas la mitad del diferencial (máx. de $0.01 o 0.01%). Solo se opera de 9:30 a 16:00 de Nueva York.`,
    fx: `Tasa media de Coinbase (cambia cada 30–60 s). Comisión $0; pagas el diferencial típico de cada par. Abierto de domingo 17:00 a viernes 17:00 de Nueva York.`,
  }[m];
  return `<div class="seg mk">${seg}</div>
    <form class="search" data-search><input id="q-${m}" type="search" enterkeyhint="search" autocomplete="off" placeholder="${ph}" value="${esc(ui.query[m])}" aria-label="Buscar en ${MARKET_LABEL[m]}"><button class="btn">Buscar</button></form>
    ${body}<p class="foot">${foot}</p>`;
}

function orderRow(o) {
  const what = o.side === "buy" ? `Comprar ${usd(o.amount)}` : `Vender ${Math.round(o.frac * 100)}%`;
  const how = o.type === "limit" ? `si toca ${fmtPx(o.inst, o.limit)}` : `al abrir el mercado`;
  return `<div class="ord"><button class="ord-main" data-open="${esc(o.key)}">${icon(o.inst)}<span class="nm"><b>${esc(o.inst.sym)}</b><small>${what} ${how}</small></span></button>
    <button class="x" data-cancel="${o.id}" aria-label="Cancelar orden">Cancelar</button></div>`;
}

function viewCartera() {
  const t = E.totals(S, quoteFor);
  const pos = Object.values(S.pos).sort((a, b) => b.cost - a.cost);
  const rows = pos.map(p => {
    const v = E.positionView(p, quoteFor(p.key));
    const badges = [p.sl ? `SL ${fmtPx(p.inst, p.sl)}` : "", p.tp ? `TP ${fmtPx(p.inst, p.tp)}` : ""].filter(Boolean).join(" · ");
    return `<button class="row" data-open="${esc(p.key)}">${icon(p.inst)}
      <span class="nm"><b>${esc(p.inst.sym)} <i class="mk-tag">${MARKET_LABEL[p.inst.m]}</i></b><small>Invertiste ${usd(p.cost)}${badges ? " · " + badges : ""}${v.live ? "" : " · último precio guardado"}</small></span>
      <span class="px"><b data-v="${esc(p.key)}">${usd(v.value)}</b><small data-pl="${esc(p.key)}" class="${dirCls(v.pl)}">${usd(v.pl, { sign: true })} (${pct(v.plPct * 100, 1)})</small></span></button>`;
  }).join("");
  return `<div class="stat-row">
      <div><small>Efectivo</small><b>${usd(t.cash)}</b></div>
      <div><small>Disponible</small><b>${usd(t.cash - t.reserved)}</b></div>
      <div><small>Invertido</small><b>${usd(t.held)}</b></div>
    </div>
    <h2>Posiciones (${pos.length})</h2>
    <div class="list">${rows || `<div class="empty">No tienes posiciones abiertas. Ve a Mercados, abre algo y compra.</div>`}</div>
    <h2>Órdenes esperando (${S.orders.length})</h2>
    <div class="list">${S.orders.map(orderRow).join("") || `<div class="empty sm">Sin órdenes límite ni órdenes esperando la apertura.</div>`}</div>
    <p class="foot">Para pasar esta cartera a otro equipo usa Exportar e Importar en <button class="lnk" data-settings>Ajustes</button>.</p>`;
}

const REASON = { manual: "", limit: "orden límite", open: "al abrir", sl: "stop loss", tp: "take profit" };
function viewHistorial() {
  const f = ui.hist;
  const trades = S.trades.filter(t => f === "all" || t.m === f).slice().reverse();
  const sb = scoreboard(S.trades.filter(t => f === "all" || t.m === f)).all;
  const chips = ["all", ...MARKETS].map(m => `<button data-hist="${m}" aria-pressed="${f === m}">${m === "all" ? "Todos" : MARKET_LABEL[m]}</button>`).join("");
  const items = trades.slice(0, ui.histN).map(t => `<div class="tr">
      <span class="side ${t.side}">${t.side === "buy" ? "Compra" : "Venta"}</span>
      <span class="nm"><b>${esc(t.sym)}</b><small>${qty(t.qty)} a ${fmtPx(instOf(t.key) || { m: t.m, id: t.key.split(":")[1] }, t.px)}</small><small>${dateTime(t.t)}${REASON[t.reason] ? " · " + REASON[t.reason] : ""}</small></span>
      <span class="px"><b>${usd(t.usd)}</b>${t.side === "sell" ? `<small class="${dirCls(t.pl)}">${usd(t.pl, { sign: true })} (${pct(t.plPct * 100, 1)})</small>` : `<small class="flat">costos ${usd((t.fee || 0) + (t.slip || 0))}</small>`}</span>
    </div>`).join("");
  return `<div class="seg chips">${chips}</div>
    <div class="stat-row">
      <div><small>Operaciones</small><b>${trades.length}</b></div>
      <div><small>% ganadoras</small><b>${sb.winRate == null ? "—" : Math.round(sb.winRate * 100) + "%"}</b></div>
      <div><small>Ganancia realizada</small><b class="${dirCls(sb.total)}">${usd(sb.total, { sign: true })}</b></div>
    </div>
    <div class="list">${items || `<div class="empty">Aquí se guarda cada compra y venta.</div>`}</div>
    ${trades.length > ui.histN ? `<button class="btn ghost wide" data-more>Mostrar más</button>` : ""}
    <button class="btn wide" data-csv ${trades.length ? "" : "disabled"}>Exportar a CSV${f === "all" ? "" : " (" + MARKET_LABEL[f] + ")"}</button>`;
}

function viewLogros() {
  const now = Date.now();
  const streak = greenStreak(S.trades, now);
  const sb = scoreboard(S.trades);
  const tr = t => t ? `<b class="${dirCls(t.pl)}">${usd(t.pl, { sign: true })}</b><small>${esc(t.sym)} · ${pct(t.plPct * 100, 1)}</small>` : "<b>—</b>";
  const card = (label, b) => `<div class="sb">
      <h3>${label}</h3>
      <div class="sb-grid">
        <div><small>Ganancia total</small><b class="${dirCls(b.total)}">${usd(b.total, { sign: true })}</b></div>
        <div><small>% ganadoras</small><b>${b.winRate == null ? "—" : Math.round(b.winRate * 100) + "%"}</b><small>${b.n} cerradas</small></div>
        <div><small>Mejor</small>${tr(b.best)}</div>
        <div><small>Peor</small>${tr(b.worst)}</div>
      </div></div>`;
  const grid = ACHIEVEMENTS.map(a => {
    const got = A.unlocked[a.id];
    return `<div class="ach ${got ? "got" : ""}"><span class="ach-i" aria-hidden="true">${a.icon}</span><b>${esc(a.name)}</b><small>${got ? "Desbloqueado " + dateTime(got) : esc(a.desc)}</small></div>`;
  }).join("");
  return `<div class="streak"><span>🔥</span><div><b>${streak} ${streak === 1 ? "día" : "días"} en verde</b><small>Días seguidos cerrando operaciones con ganancia neta.</small></div></div>
    <h2>Marcadores</h2>
    <div class="seg chips">${["all", ...MARKETS].map(m => `<button data-sb="${m}" aria-pressed="${ui.sb === m}">${m === "all" ? "Todo" : MARKET_LABEL[m]}</button>`).join("")}</div>
    ${card(ui.sb === "all" ? "Todos los mercados" : MARKET_LABEL[ui.sb], sb[ui.sb])}
    <h2>Logros (${Object.keys(A.unlocked).length}/${ACHIEVEMENTS.length})</h2>
    <p class="foot">Los logros se guardan aparte: siguen aunque reinicies la cartera.</p>
    <div class="ach-grid">${grid}</div>`;
}

// ---------------------------------------------------------------- sheet: instrument
function openSheet(key) {
  const inst = instOf(key);
  if (!inst) return;
  if (!live.get(key)) setLive(inst, {}, { check: false });
  const wasOpen = !!ui.sheet;
  ui.sheet = { kind: "inst", key, ivl: CFG.ivl, side: null, type: "market", amount: CFG.lastBuy, frac: 1, limit: null };
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  $("#scrim").hidden = false; $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
  loadChart();
  if (TEST) return;
  if (inst.m === "stock" && fh.hasKey()) { fh.watch([inst.id]); stockQuote(inst.id).catch(noteError); }
  if (inst.m === "crypto") crypto.watch([inst.id]).catch(noteError);
  if (inst.m === "meme") kick("meme");
}
function openSettings() {
  const wasOpen = !!ui.sheet;
  ui.sheet = { kind: "settings" };
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  $("#scrim").hidden = false; $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
}
function closeSheet(fromPop) {
  if (!ui.sheet) return;
  if (chart && (chart.src === "twelvedata" || chart.src === "cache")) td.saveLive(chart.sym, chart.ivl, chart.bars).catch(() => {});
  if (chart?.key?.startsWith("crypto:")) crypto.watchChart(null);
  chart = null; chartToken = null;
  ui.sheet = null;
  $("#scrim").hidden = true; $("#sheet").hidden = true; $("#sheet").innerHTML = "";
  document.body.classList.remove("noscroll");
  if (!fromPop && history.state?.sheet) history.back();
}

function marketLine(inst, now = Date.now()) {
  if (inst.m === "meme" || inst.m === "crypto") return `<span class="mkt open">Abierto 24/7</span>`;
  const st = mstatus(inst.m, now);
  const name = inst.m === "stock" ? "Wall Street" : "Divisas";
  if (st.open) return `<span class="mkt open">${name} abierto · cierra en <b data-cd="${st.closesAt}">${countdown(st.closesAt - now)}</b></span>`;
  return `<span class="mkt closed">${name} cerrado · abre en <b data-cd="${st.nextOpen}">${countdown(st.nextOpen - now)}</b></span>`;
}

function statsFor(inst, L) {
  const s = [];
  if (inst.m === "meme") {
    s.push(["Market cap", usd(L.mc, { compact: true })], ["Liquidez", usd(L.liq, { compact: true })], ["Volumen 24 h", usd(L.vol, { compact: true })]);
    if (inst.born) s.push(["Edad", `<span data-age="${inst.born}">${ago(inst.born)}</span>`]);
  } else if (inst.m === "crypto") {
    const m = crypto.meta[inst.id] || {};
    s.push(["Volumen 24 h", usd(L.vol, { compact: true })]);
    if (m.mc) s.push(["Market cap", usd(m.mc, { compact: true })]);
    if (m.rank) s.push(["Lugar por tamaño", "#" + m.rank]);
    s.push(["Costos", "0.1% + 0.02%"]);
  } else if (inst.m === "stock") {
    s.push(["Apertura", price(L.o)], ["Máximo", price(L.hi)], ["Mínimo", price(L.lo)], ["Cierre anterior", price(L.prev)]);
  } else {
    const p = FX_BY_ID[inst.id];
    const pip = inst.quote === "JPY" ? 0.01 : inst.id === "USDMXN" ? 0.0001 : 0.0001;
    s.push(["Diferencial típico", `${(p.spread / pip).toFixed(1)} pips`], ["Cambio vs. ayer", pct(L.ch24, 3)], ["Fuente", "Coinbase (media)"]);
  }
  return `<div class="stats">${s.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join("")}</div>`;
}

function changeLine(inst, L) {
  if (offline()) return `<div class="chg flat">sin conexión</div>`;
  if (inst.m === "meme") return `<div class="chg">${[["5m", L.ch5m], ["1h", L.ch1h], ["6h", L.ch6h], ["24h", L.ch24]].map(([k, v]) => `<span class="${dirCls(v)}">${pct(v, 1)}</span> ${k}`).join(" · ")}</div>`;
  const lbl = inst.m === "fx" ? "vs. ayer" : inst.m === "stock" ? "hoy" : "24 h";
  return `<div class="chg"><span data-c="${esc(inst.key)}" class="${dirCls(L.ch24)}">${pct(L.ch24)}</span> ${lbl}</div>`;
}

function renderSheet() {
  const el = $("#sheet");
  if (!ui.sheet) return;
  if (ui.sheet.kind === "settings") { el.innerHTML = settingsHTML(); bindSettings(); return; }
  const sh = ui.sheet, key = sh.key, inst = instOf(key), L = live.get(key) || {};
  const p = S.pos[key];
  const needKey = inst.m === "stock" && !CFG.finnhubKey;
  const myOrders = S.orders.filter(o => o.key === key);
  const myAlerts = CFG.alerts.filter(a => a.key === key);
  const posHTML = p ? (() => {
    const v = E.positionView(p, quoteFor(key));
    const avg = inst.m === "fx" ? p.avg : p.cost / p.qty;
    return `<section class="card pos">
      <h3>Tu posición</h3>
      <div class="stats">
        <div><small>Cantidad</small><b>${qty(p.qty)}</b></div>
        <div><small>Vale</small><b data-v="${esc(key)}">${usd(v.value)}</b></div>
        <div><small>Resultado</small><b data-pl="${esc(key)}" class="${dirCls(v.pl)}">${usd(v.pl, { sign: true })} (${pct(v.plPct * 100, 1)})</b></div>
        <div><small>Precio promedio</small><b>${fmtPx(inst, avg)}</b></div>
      </div>
      <div class="stops">
        <label>Stop loss <input id="slIn" type="number" inputmode="decimal" step="any" min="0" placeholder="precio" value="${p.sl ?? ""}"></label>
        <div class="chips">${[5, 10, 20].map(n => `<button data-sl="${n}">−${n}%</button>`).join("")}</div>
        <label>Take profit <input id="tpIn" type="number" inputmode="decimal" step="any" min="0" placeholder="precio" value="${p.tp ?? ""}"></label>
        <div class="chips">${[10, 25, 50].map(n => `<button data-tp="${n}">+${n}%</button>`).join("")}</div>
        <button class="btn" data-savestops>Guardar stop loss y take profit</button>
        <small class="mut">Se venden solos cuando el precio en vivo los toca${inst.m === "stock" || inst.m === "fx" ? " (con el mercado abierto)" : ""}. Los % son desde tu precio promedio.</small>
      </div></section>`;
  })() : "";
  el.innerHTML = `
    <div class="sh-head">${icon(inst)}<div class="sh-title"><h2>${esc(inst.sym)}</h2><small>${esc(inst.name)} · ${MARKET_LABEL[inst.m]}</small></div>
      <button class="close" data-close aria-label="Cerrar">✕</button></div>
    <div class="sh-body">
      <div class="big" data-p="${esc(key)}">${L.px > 0 ? fmtPx(inst, L.px) : "—"}</div>
      ${changeLine(inst, L)}
      <div class="mline">${marketLine(inst)}</div>
      ${needKey ? noKeyCard() : `
      <div class="chart-bar">
        <div class="seg tiny">${["1m", "5m", "1h", "1d"].map(i => `<button data-ivl="${i}" aria-pressed="${sh.ivl === i}">${i}</button>`).join("")}</div>
        <div class="seg tiny">${[["candles", "Velas"], ["line", "Línea"]].map(([k, l]) => `<button data-mode="${k}" aria-pressed="${CFG.chartMode === k}">${l}</button>`).join("")}</div>
      </div>
      <canvas id="chart" aria-label="Gráfica de ${esc(inst.sym)}"></canvas>
      <div class="chart-note" id="chartNote">${esc(chart?.note || "")}</div>
      ${statsFor(inst, L)}`}
      ${posHTML}
      ${myOrders.length ? `<section class="card"><h3>Órdenes de ${esc(inst.sym)}</h3><div class="list">${myOrders.map(orderRow).join("")}</div></section>` : ""}
      ${needKey ? "" : `<section class="card">
        <h3>Avísame cuando toque</h3>
        <form class="alert-form" data-alertform><input id="alertIn" type="number" inputmode="decimal" step="any" min="0" placeholder="precio" aria-label="Precio del aviso"><button class="btn">Avisarme</button></form>
        ${myAlerts.map(a => `<div class="alert-row">${a.dir === "above" ? "Si sube a" : "Si baja a"} ${fmtPx(inst, a.price)} <button class="lnk" data-delalert="${a.id}">quitar</button></div>`).join("")}
      </section>`}
      ${inst.m === "meme" && inst.url ? `<p class="foot"><a href="${esc(inst.url)}" target="_blank" rel="noopener">Ver en DexScreener ↗</a></p>` : ""}
    </div>
    <div class="sh-foot" id="tradeBox">${needKey ? "" : tradeBoxHTML()}</div>`;
  bindTradeBox();
  drawChartSoon(true);
}

function tradeBoxHTML() {
  const sh = ui.sheet, inst = instOf(sh.key), p = S.pos[sh.key];
  if (!sh.side) {
    return `<div class="bs">
      <button class="big-btn buy" data-side="buy">Comprar</button>
      <button class="big-btn sell" data-side="sell" ${p ? "" : "disabled"}>Vender</button></div>`;
  }
  const buy = sh.side === "buy";
  const avail = E.available(S);
  const chips = buy
    ? [50, 100, 250, 500, 1000].map(n => `<button data-amt="${n}" aria-pressed="${sh.amount === n}">$${n >= 1000 ? n / 1000 + "K" : n}</button>`).join("") + `<button data-amt="max" aria-pressed="${Math.abs(sh.amount - Math.floor(avail * 100) / 100) < 0.005}">Todo</button>`
    : [0.25, 0.5, 0.75, 1].map(f => `<button data-frac="${f}" aria-pressed="${sh.frac === f}">${f * 100}%</button>`).join("");
  return `<div class="tb ${sh.side}">
    <div class="tb-top"><button class="lnk" data-back>← Volver</button>
      <div class="seg tiny">${[["market", "A mercado"], ["limit", "Límite"]].map(([k, l]) => `<button data-type="${k}" aria-pressed="${sh.type === k}">${l}</button>`).join("")}</div></div>
    <div class="chips amt">${chips}</div>
    ${buy ? `<label class="amt-in">Monto en dólares <input id="amtIn" type="number" inputmode="decimal" step="any" min="0" value="${sh.amount || ""}"></label>` : ""}
    ${sh.type === "limit" ? `<label class="amt-in">${buy ? "Comprar si baja a" : "Vender si sube a"} <input id="limIn" type="number" inputmode="decimal" step="any" min="0" value="${sh.limit ?? ""}"></label>` : ""}
    <div class="quote" id="quote" aria-live="polite"></div>
    ${swipeHTML(sh.side, buy ? "Desliza para comprar" : "Desliza para vender")}
  </div>`;
}

function tradePreview() {
  const sh = ui.sheet, inst = instOf(sh.key), p = S.pos[sh.key];
  const now = Date.now();
  const q = quoteFor(sh.key);
  const mkt = mstatus(inst.m, now);
  const lines = [];
  let ok = true;
  const isLimit = sh.type === "limit";
  if (isLimit && !(sh.limit > 0)) { lines.push("Pon el precio límite."); ok = false; }
  const qx = isLimit && sh.limit > 0 && q ? { ...q, px: sh.limit } : q;
  if (!q) { lines.push(offline() ? "Sin conexión: no se puede operar sin precio en vivo." : "Esperando precio en vivo…"); ok = false; }
  if (sh.side === "buy") {
    const avail = E.available(S);
    if (!(sh.amount > 0)) { lines.push("Elige un monto."); ok = false; }
    else if (sh.amount > avail + 1e-9) { lines.push(`No te alcanza: tienes ${usd(avail)} disponibles.`); ok = false; }
    else if (qx) {
      const r = quoteBuy(inst, sh.amount, qx);
      if (r) lines.push(`Recibes ~${qty(r.qty)} ${esc(inst.m === "fx" ? inst.base : inst.sym)} a ${fmtPx(inst, r.eff)} · comisión ${usd(r.fee)} · ${inst.m === "meme" ? "impacto" : inst.m === "crypto" ? "deslizamiento" : "diferencial"} ${usd(r.slip)}`);
    }
  } else if (p && qx) {
    const r = quoteSell(inst, p, sh.frac, qx);
    if (r) lines.push(`Recibes ~${usd(r.proceeds)} · resultado <span class="${dirCls(r.pl)}">${usd(r.pl, { sign: true })} (${pct(r.plPct * 100, 1)})</span> · comisión ${usd(r.fee)} · ${inst.m === "meme" ? "impacto" : inst.m === "crypto" ? "deslizamiento" : "diferencial"} ${usd(r.slip)}`);
  }
  if (isLimit && sh.limit > 0) {
    lines.push(`Se llena con el precio en vivo cuando toque ${fmtPx(inst, sh.limit)}, mientras la app esté abierta; al abrirla se revisa con el precio actual.`);
    if (q && (sh.side === "buy" ? q.px <= sh.limit : q.px >= sh.limit)) lines.push("El precio ya está ahí: se llenará al confirmar.");
  }
  if (!mkt.open) {
    lines.push(`<b>${inst.m === "stock" ? "Wall Street" : "Divisas"} está cerrado:</b> la orden espera a la apertura (en <b data-cd="${mkt.nextOpen}">${countdown(mkt.nextOpen - now)}</b>) y se llena con el primer precio real.`);
    if (!q) ok = sh.side === "buy" ? sh.amount > 0 && sh.amount <= E.available(S) : !!p;
  }
  return { html: lines.join("<br>"), ok };
}

function bindTradeBox() {
  const box = $("#tradeBox");
  if (!box || !ui.sheet || ui.sheet.kind !== "inst") return;
  const upd = () => { const r = tradePreview(); const qd = $("#quote"); if (qd) qd.innerHTML = r.html; setSwipeEnabled(box, r.ok); };
  upd();
  const amt = $("#amtIn"), lim = $("#limIn");
  if (amt) amt.oninput = () => { ui.sheet.amount = +amt.value; $$(".chips.amt button").forEach(b => b.setAttribute("aria-pressed", "false")); upd(); };
  if (lim) lim.oninput = () => { ui.sheet.limit = +lim.value; upd(); };
  bindSwipe(box, submitTrade);
  box._upd = upd;
}

function submitTrade() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "inst") return;
  const inst = instOf(sh.key);
  const now = Date.now();
  const spec = sh.side === "buy"
    ? { side: "buy", type: sh.type, amount: Math.round(sh.amount * 100) / 100, limit: sh.limit }
    : { side: "sell", type: sh.type, frac: sh.frac, limit: sh.limit };
  try {
    const r = E.placeOrder(S, inst, spec, quoteFor(sh.key), now, mstatus(inst.m, now));
    if (sh.side === "buy") { CFG.lastBuy = spec.amount; saveCfg(); }
    sh.side = null;
    if (r.trade) { celebrate(r.trade); afterTrades([r.trade]); }
    else {
      const o = r.order;
      toast(o.type === "limit" ? `Orden límite puesta: ${o.side === "buy" ? "comprar" : "vender"} ${inst.sym} a ${fmtPx(inst, o.limit)}` : `Orden puesta: se llena al abrir el mercado`, "");
      vibrate(15);
      saveSoon(0);
      runChecks(sh.key);
      renderView(); renderSheet();
    }
  } catch (e) {
    toast(e.message, "down");
    vibrate(80);
  }
}

// ---------------------------------------------------------------- chart
async function loadChart() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "inst") return;
  const inst = instOf(sh.key), ivl = sh.ivl;
  if (inst.m === "stock" && !CFG.finnhubKey) return;
  if (chart && (chart.src === "twelvedata" || chart.src === "cache")) td.saveLive(chart.sym, chart.ivl, chart.bars).catch(() => {});
  const token = {};
  chartToken = token;
  const tickBars = () => ticksToBars(ticks.get(sh.key) || [], ivl);
  chart = { key: sh.key, ivl, bars: tickBars(), src: "live", note: TEST ? "Modo de prueba: gráfica con precios en vivo." : "Cargando velas…", sym: tdSymbol(inst) };
  setChartNote(chart.note); drawChartSoon(true);
  if (TEST) return;
  let bars, srcName, note;
  const now = Date.now();
  try {
    if (inst.m === "crypto") {
      bars = await crypto.candles(inst.id, ivl);
      srcName = crypto.mode;
      note = `Velas de ${srcName === "binance" ? "Binance" : "Coinbase"} en vivo.`;
      if (srcName === "binance") crypto.watchChart(inst.id, ivl);
    } else if (inst.m === "meme") {
      bars = await dex.candles(inst.pair, ivl);
      srcName = "geckoterminal";
      note = "Velas de GeckoTerminal; la última se mueve con el precio en vivo de DexScreener.";
      if (bars.length < 2) throw new SourceError("geckoterminal", "notfound", "Sin velas");
    } else {
      if (!CFG.twelveKey) throw new SourceError("twelvedata", "nokey", "Sin clave");
      const r = await td.series(tdSymbol(inst), ivl, { now, lastActive: H.lastActivity(inst.m, now) });
      bars = r.bars; srcName = r.src;
      const b = await td.status(now);
      note = (r.src === "cache" ? "Velas de Twelve Data guardadas en el teléfono (no gastaron crédito)" : "Velas de Twelve Data, guardadas en el teléfono") + ` · hoy usaste ${b.used} de ${DAILY_CAP}.` +
        (r.stale ? " No se pudieron actualizar; se muestra la copia guardada." : "");
    }
  } catch (e) {
    if (chartToken !== token) return;
    noteError(e);
    const fallback = "La gráfica usa los precios en vivo desde que abriste la app.";
    const msg = {
      geckoterminal: "GeckoTerminal no tiene velas de esta moneda. " + fallback,
      twelvedata: e.kind === "nokey" ? "Sin clave de Twelve Data: " + fallback.toLowerCase() + " Ponla en Ajustes para ver velas."
        : e.kind === "auth" ? "Twelve Data rechazó tu clave (revisa Ajustes). " + fallback
        : e.kind === "limit" ? (e.body === "day" ? "Se acabaron las 800 velas de hoy de Twelve Data. " : "Twelve Data: espera un minuto para más velas. ") + fallback
        : e.kind === "premium" ? "Twelve Data no da velas de este símbolo en el plan gratis. " + fallback
        : "No llegaron velas de Twelve Data. " + fallback,
    }[e.source] || (e.kind === "offline" ? "Sin conexión. " : "No llegaron velas. ") + fallback;
    chart = { key: sh.key, ivl, bars: tickBars(), src: "live", note: msg, sym: tdSymbol(inst) };
    setChartNote(msg); drawChartSoon(true);
    return;
  }
  if (chartToken !== token) return;
  okSrc(srcName === "cache" ? "twelvedata" : srcName);
  const last = bars[bars.length - 1];
  for (const k of ticks.get(sh.key) || []) if (!last || k.t >= last.t) applyTick(bars, ivl, k.t, k.px);
  chart = { key: sh.key, ivl, bars, src: srcName, note, sym: tdSymbol(inst) };
  setChartNote(note); drawChartSoon(true);
}
function setChartNote(t) { const el = $("#chartNote"); if (el) el.textContent = t; }

let chartDrawAt = 0, chartTimer = null;
function drawChartSoon(now) {
  const run = () => {
    chartDrawAt = Date.now(); chartTimer = null;
    const c = $("#chart");
    if (!c || !chart || !ui.sheet) return;
    const inst = instOf(chart.key);
    const bars = chart.src === "live" ? ticksToBars(ticks.get(chart.key) || [], chart.ivl) : chart.bars;
    drawChart(c, bars, { mode: CFG.chartMode, dp: inst?.m === "fx" ? (inst.dp ?? 5) : null, ivl: chart.ivl, empty: chart.src === "live" ? "La gráfica se dibuja con los precios en vivo mientras tienes la app abierta." : "" });
  };
  if (now) return run();
  if (chartTimer) return;
  chartTimer = setTimeout(run, Math.max(0, 250 - (Date.now() - chartDrawAt)));
}

// ---------------------------------------------------------------- sheet: settings
function settingsHTML() {
  const ns = notifySupport();
  const perm = ns.ok ? { granted: "Permitidos ✓", denied: "Bloqueados en el navegador", default: "Sin permiso todavía" }[ns.permission] : ns.why;
  const tog = (k, label) => `<label class="tog"><input type="checkbox" data-notif="${k}" ${CFG.notif[k] ? "checked" : ""}><span>${label}</span></label>`;
  const keyRow = (id, label, val, link, linkText) => `<div class="keyrow">
      <label for="${id}">${label}</label>
      <div class="key-in"><input id="${id}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Pega tu clave aquí" value="${val ? "••••••••" + esc(val.slice(-4)) : ""}" data-masked="${val ? 1 : 0}"><button class="btn" data-savekey="${id}">Guardar</button></div>
      <small>Créala gratis en <a href="${link}" target="_blank" rel="noopener">${linkText}</a>. Se guarda solo en este teléfono; no va en el respaldo ni en ningún archivo. ${val ? `<button class="lnk" data-delkey="${id}">Borrar clave</button>` : ""}</small>
      <small class="key-status" id="${id}-st"></small>
    </div>`;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return `<div class="sh-head"><div class="sh-title"><h2>Ajustes</h2><small>Todo se guarda solo en este teléfono</small></div><button class="close" data-close aria-label="Cerrar">✕</button></div>
  <div class="sh-body settings">
    <section class="card"><h3>Claves de precios</h3>
      ${keyRow("fhKey", "Finnhub (acciones)", CFG.finnhubKey, FINNHUB_SIGNUP, "finnhub.io/register")}
      ${keyRow("tdKey", "Twelve Data (velas de acciones y divisas, opcional)", CFG.twelveKey, TWELVE_SIGNUP, "twelvedata.com/register")}
      <small class="mut" id="tdBudget"></small>
    </section>
    <section class="card"><h3>Avisos al teléfono</h3>
      <p class="mut">Permiso: <b>${esc(perm)}</b></p>
      ${ns.ok && ns.permission !== "granted" ? `<button class="btn" data-askperm>Permitir avisos</button>` : ""}
      ${tog("fills", "Órdenes límite llenadas, stop loss y take profit")}
      ${tog("moves", "Movimientos fuertes de lo que tienes")}
      <label class="sel">Avisar si se mueve más de <select id="moveTh">${[3, 5, 10, 20].map(n => `<option value="${n}" ${CFG.moveTh === n ? "selected" : ""}>${n}%</option>`).join("")}</select> en 1 hora</label>
      ${tog("price", "Mis avisos de precio («NVDA tocó $X»)")}
      ${tog("summary", "Resumen al cierre de Wall Street")}
      ${tog("streak", "Rachas («llevas 4 días en verde»)")}
      <small class="mut">Llegan con la app abierta o recién minimizada. Con la app cerrada del todo haría falta un servidor de avisos, que esta versión no tiene. En iPhone, instala la app en la pantalla de inicio (iOS 16.4 o más).</small>
      ${CFG.alerts.length ? `<h4>Avisos de precio activos</h4>${CFG.alerts.map(a => `<div class="alert-row">${esc(a.inst.sym)}: ${a.dir === "above" ? "si sube a" : "si baja a"} ${fmtPx(a.inst, a.price)} <button class="lnk" data-delalert="${a.id}">quitar</button></div>`).join("")}` : ""}
    </section>
    <section class="card"><h3>Sonido</h3>${`<label class="tog"><input type="checkbox" id="soundTog" ${CFG.sound ? "checked" : ""}><span>Sonidos al operar</span></label>`}</section>
    <section class="card"><h3>Respaldo</h3>
      <p class="mut">Exporta un archivo con tu cartera, historial y logros, y ábrelo en el otro equipo con «Importar». Las claves no van en el archivo.</p>
      <div class="two"><button class="btn" data-export>Exportar archivo</button><label class="btn ghost file">Importar archivo<input type="file" id="importIn" accept="application/json,.json" hidden></label></div>
    </section>
    <section class="card"><h3>Instalar en el teléfono</h3>
      ${standalone ? `<p class="mut">Ya está instalada ✓</p>` : installPrompt ? `<button class="btn" data-install>Instalar Ghost Desk</button>` :
        `<p class="mut">${isIOS ? "En Safari toca Compartir ⬆️ y luego «Agregar a pantalla de inicio»." : "En Chrome toca el menú ⋮ y luego «Instalar app» o «Agregar a pantalla de inicio»."}</p>`}
    </section>
    <section class="card danger-zone"><h3>Reiniciar cartera</h3>
      <p class="mut">Vuelves a $10,000 y se borran posiciones, órdenes e historial. Los logros se quedan. Exporta antes si quieres guardar el historial.</p>
      <button class="btn danger" data-reset>Reiniciar cartera</button>
    </section>
    <p class="foot">Fuentes: DexScreener y GeckoTerminal (memecoins), CoinGecko y Binance o Coinbase (cripto), Finnhub (acciones), Twelve Data (velas de acciones y divisas), Coinbase (divisas). Dinero falso, precios reales. Nada aquí es una recomendación.</p>
  </div>`;
}

function bindSettings() {
  td.status().then(b => { const el = $("#tdBudget"); if (el && CFG.twelveKey) el.textContent = `Twelve Data: hoy usaste ${b.used} de ${DAILY_CAP} velas (el límite se reinicia a medianoche UTC).`; }).catch(() => {});
  for (const id of ["fhKey", "tdKey"]) {
    const inp = $("#" + id);
    inp.addEventListener("focus", () => { if (inp.dataset.masked === "1") { inp.value = ""; inp.dataset.masked = "0"; } });
  }
}

async function saveKey(id) {
  const inp = $("#" + id), st = $("#" + id + "-st");
  if (inp.dataset.masked === "1") { st.textContent = "Pega una clave nueva para cambiarla."; return; }
  const val = inp.value.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(val)) { st.textContent = "Eso no parece una clave (solo letras y números)."; st.className = "key-status down"; return; }
  st.textContent = "Probando la clave…"; st.className = "key-status";
  const prev = id === "fhKey" ? CFG.finnhubKey : CFG.twelveKey;
  if (id === "fhKey") CFG.finnhubKey = val; else CFG.twelveKey = val;
  try {
    if (id === "fhKey") { await stockQuote("SPY"); okSrc("finnhub"); }
    else { await td._fetchSeries("AAPL", "1d", Date.now()); okSrc("twelvedata"); }
    st.textContent = "Clave guardada y funcionando ✓"; st.className = "key-status up";
  } catch (e) {
    if (e.kind === "auth") {
      if (id === "fhKey") CFG.finnhubKey = prev; else CFG.twelveKey = prev;
      st.textContent = `${id === "fhKey" ? "Finnhub" : "Twelve Data"} rechazó esa clave. Revisa que la copiaste completa.`; st.className = "key-status down";
      return;
    }
    st.textContent = e.kind === "limit" ? "Clave guardada. La fuente está en su límite ahora; se probará sola en un minuto." : "Clave guardada. No se pudo probar ahora (¿internet?); se probará sola.";
  }
  await saveCfg();
  if (id === "fhKey") { fh.reset(); stockListAt = 0; statusAt = 0; lists.stock = []; kick("stock"); }
  src[id === "fhKey" ? "finnhub" : "twelvedata"] = { ok: Date.now(), err: null };
  renderBanners(); renderView();
  setTimeout(() => { if (ui.sheet?.kind === "settings") renderSheet(); }, 1500);
}

function exportBackup() {
  const text = buildBackup({ portfolio: S, achievements: A, settings: CFG });
  download(`ghost-desk-respaldo-${localDay(Date.now())}.json`, text, "application/json");
  toast("Respaldo exportado", "up");
}
async function importBackup(file) {
  try {
    const text = await file.text();
    const d = parseBackup(text);
    S = d.portfolio;
    if (d.achievements) A = mergeAchievements(A, d.achievements);
    const keep = { finnhubKey: CFG.finnhubKey, twelveKey: CFG.twelveKey };
    CFG = { ...DEFAULT_CFG, ...d.settings, ...keep, notif: { ...DEFAULT_CFG.notif, ...(d.settings.notif || {}) } };
    await Promise.all([flushSave(), saveAch(), saveCfg()]);
    toast(`Respaldo importado: ${Object.keys(S.pos).length} posiciones, ${S.trades.length} operaciones`, "up");
    closeSheet();
    renderAll();
    for (const m of MARKETS) kick(m === "stock" ? "stock" : m);
  } catch (e) {
    toast(e.message || "No se pudo importar", "down");
  }
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- search
let searchTimer = null;
async function runSearch(m, q) {
  ui.query[m] = q;
  q = q.trim();
  if (!q) { lists.search[m] = null; renderView(); return; }
  ui.searching = true;
  lists.search[m] = [];
  renderView();
  try {
    if (m === "meme") { const r = await dex.search(q); okSrc("dexscreener"); r.forEach(applyMeme); lists.search.meme = r.map(t => t.key); }
    else if (m === "crypto") {
      const r = await crypto.find(q);
      r.forEach(i => setLive(i, {}, { check: false }));
      lists.search.crypto = r.map(i => i.key);
      const t = await crypto.tickers(r.map(i => i.id));
      t.forEach(x => setLive(crypto.inst(x.id), x));
      crypto.watch(r.map(i => i.id));
    } else if (m === "stock") {
      const r = await fh.search(q);
      const Q = q.toUpperCase();
      const exact = /^[A-Z]{1,5}$/.test(Q) ? stockInst(Q, nameOf[Q]) : null;
      const all = exact && !r.some(i => i.id === Q) ? [exact, ...r] : r;
      all.forEach(i => setLive(i, {}, { check: false }));
      lists.search.stock = all.map(i => i.key);
      ui.searching = false; renderView();
      const missing = new Set();
      for (const i of all.slice(0, 8)) {
        try { if (!(await stockQuote(i.id))) missing.add(i.key); }
        catch (e) { if (["auth", "limit", "offline", "nokey"].includes(e.kind)) throw e; missing.add(i.key); }
      }
      lists.search.stock = lists.search.stock.filter(k => !missing.has(k));
    } else {
      const Q = q.toUpperCase().replace(/[^A-Z]/g, "");
      lists.search.fx = fx.FX_INSTS.filter(i => i.id.includes(Q) || i.name.toUpperCase().includes(q.toUpperCase())).map(i => i.key);
    }
  } catch (e) {
    noteError(e);
    toast(e.kind === "offline" ? "Sin conexión" : `No se pudo buscar: ${e.message?.toLowerCase() || "error"}`, "down");
  }
  ui.searching = false;
  if (ui.tab === "mercados" && ui.market === m) renderView();
}

// ---------------------------------------------------------------- events
function onClick(e) {
  const t = e.target.closest("button, [data-open], a, label");
  if (!t) return;
  const d = t.dataset;
  if (d.open) { openSheet(d.open); return; }
  if (d.tab) { setTab(d.tab); return; }
  if (d.market) { ui.market = d.market; if (ui.tab !== "mercados") setTab("mercados"); else renderView(); ensureMarketLoaded(); return; }
  if (d.memeview) { ui.memeView = d.memeview; renderView(); kick("meme"); return; }
  if (d.clear !== undefined) { lists.search[ui.market] = null; ui.query[ui.market] = ""; renderView(); return; }
  if (d.hist) { ui.hist = d.hist; ui.histN = 100; renderView(); return; }
  if (d.sb) { ui.sb = d.sb; renderView(); return; }
  if (d.more !== undefined) { ui.histN += 200; renderView(); return; }
  if (d.csv !== undefined) {
    const list = S.trades.filter(x => ui.hist === "all" || x.m === ui.hist);
    download(`ghost-desk-historial-${ui.hist === "all" ? "todo" : ui.hist}-${localDay(Date.now())}.csv`, toCSV(list), "text/csv;charset=utf-8");
    return;
  }
  if (d.cancel) { if (E.cancelOrder(S, +d.cancel)) { toast("Orden cancelada"); saveSoon(0); renderView(); renderSheet(); } return; }
  if (d.settings !== undefined) { openSettings(); return; }
  if (d.close !== undefined) { closeSheet(); return; }
  if (d.ivl) { ui.sheet.ivl = d.ivl; CFG.ivl = d.ivl; saveCfg(); $$("[data-ivl]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ivl === d.ivl)); if (ui.sheet.key.startsWith("crypto:")) crypto.watchChart(null); loadChart(); return; }
  if (d.mode) { CFG.chartMode = d.mode; saveCfg(); $$("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === d.mode)); drawChartSoon(true); return; }
  if (d.side) {
    const sh = ui.sheet, q = quoteFor(sh.key);
    sh.side = d.side; sh.type = "market"; sh.frac = 1;
    sh.limit = q ? +(q.px * (d.side === "buy" ? 0.98 : 1.02)).toPrecision(6) : null;
    if (CFG.sound) sounds.tap();
    $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return;
  }
  if (d.back !== undefined) { ui.sheet.side = null; $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return; }
  if (d.type) { ui.sheet.type = d.type; $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return; }
  if (d.amt) {
    ui.sheet.amount = d.amt === "max" ? Math.floor(E.available(S) * 100) / 100 : +d.amt;
    $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return;
  }
  if (d.frac) { ui.sheet.frac = +d.frac; $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return; }
  if (d.sl || d.tp) {
    const p = S.pos[ui.sheet.key]; if (!p) return;
    const avg = p.inst.m === "fx" ? p.avg : p.cost / p.qty;
    const v = d.sl ? avg * (1 - d.sl / 100) : avg * (1 + d.tp / 100);
    $(d.sl ? "#slIn" : "#tpIn").value = +v.toPrecision(6);
    return;
  }
  if (d.savestops !== undefined) {
    const key = ui.sheet.key, q = quoteFor(key);
    const sl = +$("#slIn").value || null, tp = +$("#tpIn").value || null;
    if (q && sl && sl >= q.px) { toast("El stop loss tiene que estar abajo del precio actual.", "down"); return; }
    if (q && tp && tp <= q.px) { toast("El take profit tiene que estar arriba del precio actual.", "down"); return; }
    E.setStops(S, key, { sl, tp }); saveSoon(0);
    toast(sl || tp ? "Stop loss y take profit guardados" : "Stop loss y take profit quitados", "up");
    renderSheet(); renderView(); return;
  }
  if (d.delalert) { CFG.alerts = CFG.alerts.filter(a => a.id !== +d.delalert); saveCfg(); renderSheet(); return; }
  if (d.savekey) { saveKey(d.savekey); return; }
  if (d.delkey) {
    if (d.delkey === "fhKey") { CFG.finnhubKey = ""; fh.reset(); } else CFG.twelveKey = "";
    saveCfg(); src[d.delkey === "fhKey" ? "finnhub" : "twelvedata"] = {}; renderSheet(); renderBanners(); renderView(); return;
  }
  if (d.askperm !== undefined) { askPermission().then(() => renderSheet()); return; }
  if (d.export !== undefined) { exportBackup(); return; }
  if (d.install !== undefined) { installPrompt?.prompt(); installPrompt = null; return; }
  if (d.reset !== undefined) {
    if (!t.dataset.sure) {
      t.dataset.sure = "1"; t.textContent = "Toca otra vez para borrar todo";
      setTimeout(() => { if (t.isConnected) { delete t.dataset.sure; t.textContent = "Reiniciar cartera"; } }, 5000);
      return;
    }
    S = E.newPortfolio(Date.now()); saveSoon(0);
    toast("Cartera reiniciada: $10,000. Tus logros siguen.", "up");
    closeSheet(); renderAll(); return;
  }
}

function onSubmit(e) {
  const f = e.target;
  e.preventDefault();
  if (f.matches("[data-search]")) { clearTimeout(searchTimer); runSearch(ui.market, f.querySelector("input").value); return; }
  if (f.matches("[data-alertform]")) {
    const v = +$("#alertIn").value, key = ui.sheet.key, q = quoteFor(key), inst = instOf(key);
    if (!(v > 0)) { toast("Pon un precio.", "down"); return; }
    if (!q) { toast("Espera el precio en vivo para crear el aviso.", "down"); return; }
    CFG.alerts.push({ id: Date.now(), key, inst: E.slimInst(inst), dir: v >= q.px ? "above" : "below", price: v, createdAt: Date.now() });
    saveCfg();
    const ns = notifySupport();
    toast(`Aviso creado: ${inst.sym} a ${fmtPx(inst, v)}` + (ns.ok && ns.permission !== "granted" ? ". Permite avisos en Ajustes para que te llegue al teléfono." : ""), "up");
    renderSheet();
  }
}

function onInput(e) {
  const t = e.target;
  if (t.matches("[data-search] input")) {
    clearTimeout(searchTimer);
    const m = ui.market, v = t.value;
    ui.query[m] = v;
    if (m === "fx" || v.trim().length >= 2 || !v.trim()) searchTimer = setTimeout(() => runSearch(m, v), m === "fx" ? 50 : 500);
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.notif) { CFG.notif[t.dataset.notif] = t.checked; saveCfg(); return; }
  if (t.id === "moveTh") { CFG.moveTh = +t.value; saveCfg(); return; }
  if (t.id === "soundTog") { CFG.sound = t.checked; saveCfg(); if (t.checked) sounds.tap(); return; }
  if (t.id === "importIn" && t.files?.[0]) importBackup(t.files[0]);
}

function setTab(tab) {
  ui.tab = tab;
  if (location.hash !== "#" + tab) history.replaceState(history.state, "", "#" + tab);
  window.scrollTo(0, 0);
  renderView();
  ensureMarketLoaded();
}
function ensureMarketLoaded() {
  if (TEST) return;
  if (ui.tab === "mercados" || ui.tab === "inicio") {
    if (ui.market === "meme" || ui.tab === "inicio") kick("meme");
    if (ui.market === "stock" && !lists.stock.length) kick("stock");
  }
}

let toastTimer = null;
function toast(text, kind = "") {
  const el = $("#toast");
  el.innerHTML = text; el.className = "toast " + kind; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

let rafPending = false;
function frame() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateHeader();
    updateDirty();
    if (ui.sheet?.kind === "inst") { $("#tradeBox")?._upd?.(); }
  });
}

function renderAll() { updateHeader(); renderBanners(); renderView(); renderTape(true); }

// ---------------------------------------------------------------- boot
async function boot() {
  await openStore(TEST ? "ghost-desk-test" : undefined);
  S = (await kv.get("portfolio")) || E.newPortfolio(Date.now());
  A = (await kv.get("achievements")) || newAchievements();
  const saved = (await kv.get("settings")) || {};
  CFG = { ...DEFAULT_CFG, ...saved, notif: { ...DEFAULT_CFG.notif, ...(saved.notif || {}) } };
  for (const k in S.pos) { const p = S.pos[k]; if (!live.get(k) && p.lastPx) live.set(k, { inst: { ...p.inst }, px: null }); }
  const h = location.hash.slice(1);
  if (["inicio", "mercados", "cartera", "historial", "logros"].includes(h)) ui.tab = h;
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  $("#scrim").addEventListener("click", () => closeSheet());
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
  addEventListener("popstate", () => { if (ui.sheet) closeSheet(true); });
  addEventListener("online", () => { renderAll(); for (const n in loops) kick(n); });
  addEventListener("offline", renderAll);
  addEventListener("resize", () => drawChartSoon());
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flushSave(); return; }
    for (const n in loops) kick(n);
    renderAll();
  });
  addEventListener("pagehide", flushSave);
  renderAll();
  setInterval(secondTick, 1000);
  if (TEST) { setupTestHooks(); return; }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  startSources();
}

function setupTestHooks() {
  window.ghostDesk = {
    state: () => S, setLive, openSheet, openSettings, closeSheet, setTab, renderAll,
    chooseSide: side => $(`[data-side="${side}"]`)?.click(),
    lists, live,
  };
  document.documentElement.dataset.ready = "1";
}

boot().catch(e => {
  console.error(e);
  $("#view").innerHTML = `<div class="banner err">No se pudo iniciar Ghost Desk: ${esc(e?.message || e)}. Recarga la página.</div>`;
});
