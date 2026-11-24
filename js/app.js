// Ghost Desk G1: fake money, real prices, four markets. Everything runs in the phone's browser.

import { FX_BY_ID, quoteBuy, quoteSell, quoteOpenMargin, START_CASH, START_CHOICES, START_MIN, START_MAX } from "./core/money.js";
import * as H from "./core/hours.js";
import * as E from "./core/engine.js";
import { scoreboard, greenStreak, localDay, toCSV, MARKET_LABEL, realizedByDay, sideLabel } from "./core/stats.js";
import { ACHIEVEMENTS, newAchievements, evaluate, achievementById } from "./core/achievements.js";
import { applyTick, ticksToBars, INTERVALS } from "./core/candles.js";
import { buildBackup, parseBackup, mergeAchievements } from "./core/backup.js";
import { STYLES, STYLE_IDS, MAX_BOTS, newBot, botName, step as botStep, cheatTick as botCheatTick, cheatFeed as botCheatFeed, BOT_CHEATS, standing, preview as botPreview } from "./core/bots.js";
import * as C from "./core/cheats.js";
import * as RP from "./core/replay.js";
import * as SW from "./sim/world.js";
import * as FUN from "./sim/fun.js";
import * as RW from "./sim/rewind.js";
import * as CLEAN from "./core/sanitize.js";
import { openStore, kv, candles as candleStore, usingMemory } from "./store.js";
import { SourceError } from "./sources/http.js";
import * as dex from "./sources/dex.js";
import { createCrypto } from "./sources/crypto.js";
import { createFinnhub, STOCKS_DEFAULT, stockInst } from "./sources/stocks.js";
import { createTwelve, tdSymbol, DAILY_CAP } from "./sources/twelve.js";
import * as fx from "./sources/fx.js";
import { esc, usd, price, pct, dirCls, qty, countdown, ago, dateTime, clock, weekdayTime, tap } from "./ui/format.js";
import * as RICH from "./core/rich.js";
import { drawChart } from "./ui/chart.js";
import { confetti, shake, bigResult, vibrate, sounds, rollNumber, jackpot as jackpotFx } from "./ui/effects.js";
import { swipeHTML, bindSwipe, setSwipeEnabled } from "./ui/swipe.js";
import { notify, askPermission, notifySupport } from "./ui/notify.js";

const TEST = new URLSearchParams(location.search).get("test");
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const MARKETS = ["meme", "crypto", "stock", "fx"];
const TABS = ["home", "markets", "portfolio", "history", "achievements"];
const FINNHUB_SIGNUP = "https://finnhub.io/register";
const TWELVE_SIGNUP = "https://twelvedata.com/register";

/** Default buy amount: 1% of the starting balance. Amount chips are fractions of it too. */
const defaultBuy = start => Math.round(start * 0.01 * 100) / 100;
const CHIP_FRACS = [0.001, 0.005, 0.01, 0.05, 0.1];

const DEFAULT_CFG = {
  finnhubKey: "", twelveKey: "", sound: false, simSound: false,
  lc: { pct: 10, warn: true, trail: false }, // Last chance: warn (or sell with the trailing stop) at −pct% from the high since you bought
  notif: { fills: true, moves: true, price: true, summary: true, streak: true }, moveTh: 5, botCheats: true,
  oracleAuto: { on: false, pct: 10, scope: "view" }, frontPct: 10,
  alerts: [], lastBuy: defaultBuy(START_CASH), chartMode: "candles", ivl: "5m", lastSummary: "", lastStreakDay: "",
};

// ---------------------------------------------------------------- state
let S, A, CFG;
// Sim mode: invented markets driven by js/sim/world.js, with its own portfolio, bots, achievements and records.
// Switching between Live and Sim reloads the app, so the two never share prices or state.
const jpKeys = new Set(); // positions that already had their JACKPOT (no second one when you sell them)
let SIM = false, W = null, REC = null, simTimer = null, simSavedAt = 0, shakeAt = 0, simListAt = 0;
let skipping = false, oracle = null, oracleVer = 0;
let capSeen = -1; // S.capCut already announced (−1: not read yet)
/**
 * The app's clock. Live: real time. Sim: the Sim clock (W.off ahead of or behind real time): it stops while the
 * app is closed or hidden and jumps forward with Skip ahead, so trades, candles, events and countdowns agree.
 */
function appNow() { return Date.now() + (SIM && W ? W.off || 0 : 0); }
const K = k => (SIM ? "sim." + k : k);
/** Sounds: Live uses "Sounds when trading"; Sim has its own switch, off until you turn it on. */
function sfx(name) { if (SIM ? CFG.simSound : CFG.sound) sounds[name]?.(); }
const needFinnhub = () => !SIM && !CFG.finnhubKey;
let BOTS = [];                // rival bots: [{id, style, name, pf (own portfolio), lastBuy, seed}]
let bootAt = Date.now();      // bots never trade on a price produced before the app was opened (Sim: the Sim clock at load)
const live = new Map();   // key → {inst, px, t, ch24, ch1h, liq, mc, vol, quoteUsd, dir, ...}
const ticks = new Map();  // key → [{t, px}] recorded while the app is open
const dirty = new Set();
const lists = { meme: { trending: [], new: [] }, memeAt: { trending: 0, new: 0 }, crypto: [], stock: [], fx: fx.FX_INSTS.map(i => i.key), search: { meme: null, crypto: null, stock: null, fx: null } };
const src = {};           // source → {ok, err, errAt}
const rand = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; // a real random draw (coin flips, airdrops)
const ui = { replay: null, tab: "home", market: "crypto", memeView: "trending", hist: "all", histN: 100, sb: "all", sheet: null, query: { meme: "", crypto: "", stock: "", fx: "" }, searching: false, resetStart: START_CASH, resetCustom: false };
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
  onState: s => { if (s.mode === "coinbase") cryptoNote = "Binance isn't reachable from your network: crypto is using Coinbase."; if (s.ws === "open") okSrc(crypto.mode); },
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
    const t = d.t || appNow();
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
  return { px: L.px, t: L.t || appNow(), liq: L.liq, quoteUsd: L.quoteUsd };
}

function instOf(key) {
  return live.get(key)?.inst || S.pos[key]?.inst || E.marginPositions(S).find(p => p.key === key)?.inst || S.orders.find(o => o.key === key)?.inst || CFG.alerts.find(a => a.key === key)?.inst || null;
}

function mstatus(m, now = appNow()) {
  if (SIM) return { open: true, since: 0 }; // Sim markets never close
  return H.marketStatus(m, now);
}

function trackedKeys(m) {
  const set = new Set();
  for (const k in S.pos) set.add(k);
  for (const x of E.marginPositions(S)) set.add(x.key);
  for (const o of S.orders) set.add(o.key);
  for (const a of CFG.alerts) set.add(a.key);
  for (const b of BOTS) for (const k in b.pf.pos) set.add(k);
  if (ui.sheet?.kind === "inst") set.add(ui.sheet.key);
  return [...set].filter(k => !m || k.startsWith(m + ":"));
}

function afterPrice(k) {
  runChecks(k);
  priceAlerts(k);
  moveAlert(k);
}

// ---------------------------------------------------------------- orders, stops, fills
function runChecks(k, now = appNow()) {
  const p = S.pos[k], o = S.orders.find(x => x.key === k), mp = E.marginPositions(S).find(x => x.key === k);
  if (!p && !o && !mp && S.cheats?.boost?.key !== k) return;
  const q = quoteFor(k);
  if (!q) return;
  const m = (p || o || mp)?.inst.m || k.split(":")[0];
  const events = E.checkKey(S, k, q, now, mstatus(m, now), { trail: trailPct() });
  if (events.length) handleEvents(events);
  else saveSoon(3000);
  lastChanceCheck(k);
}

// ---------------------------------------------------------------- Double or nothing
/** The confirmation before the flip: what you can win, and that a loss drops the whole portfolio to $100. */
function askDon() {
  const t = C.lastWin(S);
  if (!t) { toast("Double or nothing needs a winning sale as your last trade.", "down"); return; }
  const total = E.totals(S, quoteFor).total;
  const el = $("#confirm");
  el.innerHTML = `<div class="skip-box lc-box cf-box don" role="alertdialog" aria-labelledby="cfT" aria-describedby="cfD">
    <span class="lc-i" aria-hidden="true">🪙</span><b id="cfT">Double or nothing</b>
    <p>Flip a coin on your ${$usd(t.pl, { sign: true })} win on ${esc(t.sym)}. Heads: you get another ${$usd(t.pl)}.</p>
    <p id="cfD" class="warn-big">If you lose, your whole portfolio drops to $100</p>
    <p class="mut">Today it's worth ${$usd(total)}: cash and every position${E.marginPositions(S).length ? " (leveraged ones too)" : ""}, and your waiting orders are canceled.${C.isAlways(S, "don") ? " Always on: you'll get this question after every win." : ""}</p>
    <div class="two"><button class="btn sell" data-donflip>Flip the coin</button><button class="btn ghost" data-donno>Not this time</button></div></div>`;
  el.hidden = false;
}

// ---------------------------------------------------------------- money cap and Billionaire ladder
const richDate = () => new Date(RICH.AS_OF).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
function worldsRichest(cut) {
  toast(`🌍 World's richest: your ${SIM ? "Sim " : ""}portfolio stops at ${$usd(RICH.WORLD_CAP)}, the combined fortune of the world's 100 richest people. ${$usd(cut)} stayed out.`, "gold");
  vibrate([60, 40, 60]);
}
function ladderHTML() {
  const total = E.totals(S, quoteFor).total, L = RICH.ladder(total);
  const row = (r, me) => me
    ? `<div class="lad me"><span class="rk">#${L.place > 100 ? "101+" : L.place}</span><span class="nm"><b>You</b><small>${SIM ? "Sim portfolio" : "Live portfolio"}</small></span><b>${$usd(total)}</b></div>`
    : `<div class="lad"><span class="rk">#${r[0]}</span><span class="nm"><b>${esc(r[1])}</b></span><b>${$usd(r[2])}</b></div>`;
  const i = L.place - 1;
  const above = RICH.RICHEST.slice(Math.max(0, i - 2), i), below = RICH.RICHEST.slice(i, i + 2);
  const head = L.place > 100
    ? `Not in the top 100 yet. #100 is ${esc(L.above[1])} with ${$usd(L.above[2])}: ${$usd(L.above[2] - total)} to go.`
    : L.place === 1 ? `You'd be the richest person in the world.` : `You'd be <b>#${L.place}</b>. Next up: #${L.above[0]} ${esc(L.above[1])} with ${$usd(L.above[2])}, ${$usd(L.above[2] - total)} to go.`;
  return `<h2>Billionaire ladder</h2><div class="card ladder"><p>${head}</p>
    ${above.map(r => row(r)).join("")}${row(null, true)}${below.map(r => row(r)).join("")}
    <small class="mut">${RICH.SOURCE}, ${richDate()}. Your portfolio can't pass the 100 together: ${$usd(RICH.WORLD_CAP)}.</small></div>`;
}

// ---------------------------------------------------------------- Last chance
const trailPct = () => (CFG.lc.trail ? CFG.lc.pct / 100 : 0);
function lastChanceCheck(k) {
  if (!CFG.lc.warn || CFG.lc.trail || ui.lc) return;
  const q = quoteFor(k);
  if (!q) return;
  const th = CFG.lc.pct / 100;
  for (const p of [S.pos[k], ...E.marginPositions(S).filter(m => m.key === k)]) {
    if (!p || !(p.best > 0) || p.lcBest === p.best) continue;
    const dd = E.drawdown(p, q.px);
    if (dd >= th) { p.lcBest = p.best; saveSoon(); showLastChance(p, q.px, dd); return; }
  }
}

function showLastChance(p, px, dd) {
  ui.lc = { key: p.key, id: S.margin?.[p.id] === p ? p.id : null };
  const inst = p.inst, short = (p.dir || 1) < 0;
  const val = E.positionValue(S, p, quoteFor(p.key)) ?? 0, pl = val - p.cost;
  const el = $("#lastChance");
  el.innerHTML = `<div class="lc-box" role="alertdialog" aria-labelledby="lcT" aria-describedby="lcD">
    <span class="lc-i" aria-hidden="true">⏳</span><b id="lcT">LAST CHANCE</b>
    <p id="lcD"><b>${esc(inst.sym)}</b>${p.lev > 1 ? ` ${p.lev}x ${short ? "short" : "long"}` : ""} ${short ? "rose" : "fell"} <b class="down">${$pct(dd * 100, 1).replace("+", "")}</b> from its ${short ? "low" : "high"} of ${$px(inst, p.best)} since you bought. Now ${$px(inst, px)}.</p>
    <p class="mut">Your position: ${$usd(val)} · <span class="${dirCls(pl)}">${$usd(pl, { sign: true })} (${$pct(p.cost > 0 ? (pl / p.cost) * 100 : 0, 1)})</span></p>
    <div class="two"><button class="btn sell" data-lcsell>Sell now</button><button class="btn ghost" data-lckeep>Keep it</button></div>
    <small class="mut">You get this at −${CFG.lc.pct}% from the ${short ? "low" : "high"}. Change it, or let a trailing stop sell for you, in Settings.</small></div>`;
  el.hidden = false;
  vibrate([200, 100, 200]); sfx("loss");
  alertPhone("moves", `Last chance: ${inst.sym}`, `${short ? "Up" : "Down"} ${(dd * 100).toFixed(1)}% from its ${short ? "low" : "high"} since you bought. Open the app to sell.`, "lc-" + p.key);
}

function hideLastChance() { $("#lastChance").hidden = true; ui.lc = null; }

function lastChanceSell() {
  const x = ui.lc;
  hideLastChance();
  if (!x) return;
  const now = appNow();
  try {
    if (x.id) {
      const m = S.margin?.[x.id]; if (!m) return;
      if (!mstatus(m.inst.m, now).open) throw new E.TradeError("The market is closed: it can be closed when it opens.");
      const q = quoteFor(m.key); if (!q) throw new E.TradeError("No live price to close at.");
      const tr = E.closeMargin(S, m.id, 1, q, now, "manual");
      celebrate(tr); afterTrades([tr]); return;
    }
    const p = S.pos[x.key]; if (!p) return;
    const r = E.placeOrder(S, p.inst, { side: "sell", type: "market", frac: 1 }, quoteFor(x.key), now, mstatus(p.inst.m, now));
    if (r.trade) { celebrate(r.trade); afterTrades([r.trade]); }
    else { toast(`The market is closed: your ${esc(p.inst.sym)} sale fills at the open.`); saveSoon(0); renderView(); renderSheet(); }
  } catch (e) { toast(e.message, "down"); vibrate(80); }
}

function handleEvents(events) {
  const trades = [];
  for (const e of events) {
    const t = e.trade;
    if (e.type === "fill") {
      trades.push(t);
      const kind = e.order.type === "limit" ? "Your limit order filled" : "Your order filled at the market open";
      const body = `${t.side === "buy" ? "Bought" : "Sold"} ${t.sym} at ${$px(instOf(t.key), t.px)} · ${$usd(t.usd)}${t.side === "sell" ? " · " + usd(t.pl, { sign: true }) : ""}`;
      toast(kind + ": " + body, t.side === "sell" ? (t.pl >= 0 ? "up" : "down") : "");
      alertPhone("fills", kind, body, "fill-" + t.id);
    } else if (e.type === "sl" || e.type === "tp") {
      trades.push(t);
      const kind = e.type === "sl" ? "Your stop loss triggered" : "Your take profit triggered";
      const body = `Sold ${t.sym} at ${$px(instOf(t.key), t.px)} · ${$usd(t.pl, { sign: true })} (${$pct(t.plPct * 100, 1)})`;
      toast(kind + ": " + body, t.pl >= 0 ? "up" : "down");
      alertPhone("fills", kind, body, "stop-" + t.id);
    } else if (e.type === "trail") {
      trades.push(t);
      const body = `Sold ${t.sym} at ${$px(instOf(t.key) || { m: t.m }, t.px)} · ${$usd(t.pl, { sign: true })} (${$pct(t.plPct * 100, 1)}), ${CFG.lc.pct}% off its best since you bought (${$px(instOf(t.key) || { m: t.m }, e.best)})`;
      toast("📉 Trailing stop: " + body, t.pl >= 0 ? "up" : "down");
      alertPhone("fills", "Your trailing stop sold", body, "trail-" + t.id);
    } else if (e.type === "cancel") {
      toast(`Your ${e.order.inst.sym} order was canceled: ${e.reason}`, "down");
    } else if (e.type === "liq") {
      trades.push(t);
      const body = `${t.sym} ${t.lev}x ${t.dir === -1 ? "short" : "long"}: the loss reached your ${$usd(t.cost)} margin` + (t.usd > 0 ? ` · Insurance paid back ${$usd(t.usd)}` : "");
      toast("💥 Liquidated: " + body, "down");
      alertPhone("fills", "Liquidated", body, "liq-" + t.id);
    } else if (e.type === "saved") {
      toast(`❤️‍🩹 Second chance: your ${esc(e.pos.inst.sym)} ${e.pos.lev}x position was saved from liquidation`, "gold");
    }
  }
  if (trades.length) {
    const lastSell = [...trades].reverse().find(t => t.side === "sell");
    celebrate(lastSell || trades[trades.length - 1]);
    afterTrades(trades);
  } else { saveSoon(); renderView(); renderSheet(); }
}

function afterTrades(trades) {
  if (SIM) { simAfterTrades(trades); oracleVer++; }
  // Always on: used-up cheats arm themselves again; Double or nothing asks after every win
  if (C.rearm(S).length) cheatChanged();
  if (C.isAlways(S, "don") && trades.includes(C.lastWin(S)) && !skipping) setTimeout(askDon, 900);
  const tot = E.totals(S, quoteFor).total;
  const st = H.stockStatus(appNow());
  const kept = trades.filter(t => !t.ghosted && S.trades.includes(t)); // a Ghost trade that was erased never happened
  const got = evaluate(A, kept, { trades: S.trades, total: tot, start: S.start, now: appNow(), stockOpenSince: st.open ? st.since : null, cheated: E.isCheated(S) });
  for (const id of got) {
    const a = achievementById(id);
    setTimeout(() => toast(`${a.icon} Achievement: ${a.name}${A.cheated?.[id] ? " ★ (with cheats)" : ""}`, "gold"), 1400);
  }
  if (got.length) saveAch();
  saveSoon(0);
  streakCheck();
  renderView();
  renderSheet();
  frame();
}

const cheatTxt = t => (t.cheat?.length ? " ★ " + t.cheat.join(", ") : "");
function celebrate(t) {
  if (!t) return;
  if (t.ghosted) { toast(`👻 Ghost trade: the ${$usd(t.ghosted)} loss on ${esc(t.sym)} never happened`, "gold"); vibrate(30); return; }
  if (t.side === "sell") {
    const win = t.pl >= 0;
    bigResult($("#result"), { text: usd(t.pl, { sign: true }), sub: `${t.sym} · ${$pct(t.plPct * 100, 1)}${cheatTxt(t)}`, win });
    if (win) { confetti($("#confetti"), { big: SIM }); vibrate(SIM ? [40, 30, 40, 30, 40, 30, 120] : [25, 40, 25, 40, 60]); sfx(SIM ? "sell" : "win"); if (SIM) sfx("win"); }
    else { shake($("#app")); vibrate(220); sfx("loss"); }
  } else {
    if (t.reason === "manual") toast(`${t.dir === -1 ? "Shorted" : "Bought"} ${$usd(t.usd)} of ${esc(t.sym)}${t.lev > 1 ? ` at ${t.lev}x` : ""}${cheatTxt(t)}`, "up");
    vibrate(20);
    sfx(SIM ? "buy" : "fill");
  }
}

function alertPhone(kind, title, body, tag) {
  if (!CFG.notif[kind]) return;
  const plain = x => String(x).replace(/<[^>]*>/g, "");
  title = plain(title); body = plain(body);
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
    const text = `${L.inst.sym} hit ${$px(L.inst, a.price)}`;
    toast("🔔 " + text, "gold");
    sfx(SIM ? "buy" : "fill");
    alertPhone("price", text, `Live price: ${fmtPx(L.inst, L.px)}`, "alert-" + a.id);
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
  const text = `${L.inst.sym} ${ch > 0 ? "rose" : "fell"} ${Math.abs(ch).toFixed(1)}% in 1 hour`;
  toast((ch > 0 ? "📈 " : "📉 ") + text, ch > 0 ? "up" : "down");
  alertPhone("moves", text, `Now ${fmtPx(L.inst, L.px)}. You have an open position.`, "move-" + k);
}

function streakCheck() {
  const now = appNow(), today = localDay(now);
  if (CFG.lastStreakDay === today) return;
  const real = realizedByDay(S.trades)[today];
  const n = greenStreak(S.trades, now);
  if (real > 0 && n >= 2) {
    CFG.lastStreakDay = today; saveCfg();
    const text = `${n} green days in a row 🔥`;
    setTimeout(() => toast(text, "gold"), 2600);
    alertPhone("streak", text, "Keep it going: close in the green again tomorrow.", "streak");
  }
}

function dailySummary(now) {
  if (SIM) return;
  if (!S.trades.length && !Object.keys(S.pos).length) return;
  const p = H.nyParts(now);
  const sess = H.stockSessionFor(p.y, p.mo, p.d);
  const key = H.ymd(p.y, p.mo, p.d);
  if (!sess || now < sess.close || CFG.lastSummary === key) return;
  if (now - sess.close > 8 * 3600e3) return; // too late to call it "at the close"
  CFG.lastSummary = key; saveCfg();
  const tot = E.totals(S, quoteFor).total;
  const day = S.days[localDay(now)];
  const todayTrades = S.trades.filter(t => localDay(t.t) === localDay(now));
  const real = todayTrades.reduce((a, t) => a + (t.side === "sell" ? t.pl : 0), 0);
  const n = todayTrades.length;
  const text = `Your portfolio is worth ${$usd(tot)}` + (day ? ` (${$usd(tot - day.first, { sign: true })} since ${clock(day.firstT)})` : "") +
    ` · ${n} ${n === 1 ? "trade" : "trades"} today · realized ${$usd(real, { sign: true })}`;
  toast("🔔 Wall Street closed. " + text);
  alertPhone("summary", "Closing summary", text, "summary");
}

// ---------------------------------------------------------------- persistence
// Every change marks what it touched and is written at once (or within `ms`); a later, slower request never
// postpones an earlier one. A save counts only when its IndexedDB transaction is complete.
const DUE = new Set();
let saveTimer = null, saveAt = 0, saveLoud = false, saveErr = null, pillTimer = null;
let loadIssues = [];          // what had to be repaired in the saved data (told in a banner)
const VALUES = {
  portfolio: () => [K("portfolio"), S], achievements: () => [K("achievements"), A], settings: () => ["settings", CFG],
  bots: () => [K("bots"), { v: 1, list: BOTS }], records: () => ["sim.records", REC], world: () => ["sim.world", W],
};
function saveSoon(ms = 400) {
  DUE.add("portfolio");
  if (ms < 1000) { saveLoud = true; if (SIM) DUE.add("world"); } // a position and its Sim coin are saved together
  saveIn(ms);
}
function saveIn(ms) {
  const at = Date.now() + ms;
  if (saveTimer && saveAt <= at) return;
  clearTimeout(saveTimer);
  saveAt = at;
  saveTimer = setTimeout(flushSave, ms);
}
/** Bad numbers never reach the disk: they are repaired in the live data, and the app says so. */
function checkData(keys) {
  const issues = [], now = appNow();
  if (keys.includes("portfolio")) CLEAN.cleanPortfolio(S, now, issues);
  if (keys.includes("bots")) BOTS = CLEAN.cleanBots(BOTS, now, issues);
  if (keys.includes("achievements")) CLEAN.cleanAchievements(A, now, issues);
  if (keys.includes("settings")) CFG = CLEAN.cleanSettings(CFG, DEFAULT_CFG, issues);
  if (keys.includes("world")) W = CLEAN.cleanWorld(W, newWorld, issues) || newWorld();
  if (issues.length) noteIssues(issues);
}
function noteIssues(issues) {
  for (const x of issues) if (!loadIssues.includes(x) && loadIssues.length < 30) loadIssues.push(x);
  console.warn("Repaired data:", issues.join("; "));
  if (S && CFG) renderBanners();
}
/** Write everything that changed, in one transaction. Resolves true when it is on disk. */
async function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  const keys = [...DUE].filter(k => (k !== "world" || W) && (k !== "records" || REC)), loud = saveLoud;
  DUE.clear(); saveLoud = false;
  if (!keys.length) return !saveErr;
  try {
    checkData(keys);
    await kv.setMany(keys.map(k => VALUES[k]()));
    const was = saveErr;
    saveErr = null;
    if (was) renderBanners();
    if ((loud || was) && !usingMemory()) showSaved();
    return true;
  } catch (e) {
    console.warn("Could not save", e?.message);
    for (const k of keys) DUE.add(k);
    const first = !saveErr;
    saveErr = e || new Error("unknown error"); saveLoud = true;
    renderBanners();
    if (first) toast("⚠️ Your last changes are not saved", "down");
    saveIn(5000); // keep trying
    return false;
  }
}
function saveNow(key, loud = true) { DUE.add(key); if (loud) saveLoud = true; return flushSave(); }
const saveAch = () => saveNow("achievements");
const saveRec = () => saveNow("records", false);
const saveWorld = () => saveNow("world", false);
const saveCfg = () => saveNow("settings");
const saveBots = (loud = true) => saveNow("bots", loud);
/** The app is being hidden or closed: write everything again. The requests are issued before this returns. */
function saveOnExit() {
  for (const k of ["portfolio", "bots", "achievements"]) DUE.add(k);
  if (SIM) { DUE.add("world"); DUE.add("records"); }
  return flushSave();
}
function showSaved() {
  const el = $("#saved");
  el.hidden = false;
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => { el.hidden = true; }, 1500);
}
function saveBanners() {
  const b = [];
  if (saveErr) b.push(["err", `Your last changes are not saved (${esc(saveErr.name === "QuotaExceededError" ? "the phone has no space left" : saveErr.message || saveErr.name)}). Trying again… <button class="lnk" data-savenow>Try now</button> <button class="lnk" data-export>Export backup</button>`]);
  if (usingMemory()) b.push(["err", `The phone's storage didn't open, so nothing you do now will be saved (what you had saved is untouched). <button class="lnk" data-reload>Reload</button>`]);
  if (loadIssues.length) b.push(["warn", `Some saved data was damaged and was repaired; everything else is intact: ${esc(loadIssues.slice(0, 4).join(", "))}${loadIssues.length > 4 ? ` and ${loadIssues.length - 4} more` : ""}. <button class="lnk" data-issuesok>OK</button>`]);
  return b;
}

/** Read one saved value and repair it. If it needed repairs, the damaged original is kept apart. */
async function loadClean(key, clean) {
  const issues = [], value = clean(await kv.get(key), issues);
  if (issues.length) {
    noteIssues(issues);
    try { await kv.set("damaged." + key, { at: Date.now(), value: await kv.get(key) }); } catch { /* only a copy */ }
  }
  return value;
}

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
  const showing = ui.tab === "home" || (ui.tab === "markets" && ui.market === "meme");
  if (!document.hidden) {
    const views = new Set();
    if (showing) views.add(ui.tab === "home" ? "trending" : ui.memeView);
    if (BOTS.length) { views.add("trending"); views.add("new"); } // the bots look at memecoins too
    for (const view of views) {
      if (!lists.meme[view].length || Date.now() - lists.memeAt[view] > 90e3) await loadMemeList(view);
      else lists.meme[view].forEach(k => need.add(k));
    }
    if (showing) (lists.search.meme || []).forEach(k => need.add(k));
  }
  const addrs = [...need].map(k => k.slice(5));
  if (!addrs.length) return;
  const toks = await dex.tokens(addrs);
  okSrc("dexscreener");
  toks.forEach(applyMeme);
}
function applyMeme(t) {
  setLive(t, { px: t.px, t: appNow(), liq: t.liq, mc: t.mc, vol: t.vol, ch24: t.ch.h24, ch1h: t.ch.h1, ch5m: t.ch.m5, ch6h: t.ch.h6 });
}
async function loadMemeList(view) {
  const toks = view === "trending" ? await dex.trending() : await dex.newest();
  okSrc("dexscreener");
  lists.meme[view] = toks.map(t => t.key);
  lists.memeAt[view] = Date.now();
  toks.forEach(applyMeme);
  if (ui.tab === "markets" && ui.market === "meme" || ui.tab === "home") renderView();
}

let cryptoTopAt = 0;
async function cryptoLoop() {
  if (!lists.crypto.length || Date.now() - cryptoTopAt > 15 * 60e3) {
    const r = await crypto.top(30);
    if (r.fromCG) okSrc("coingecko"); else noteError(new SourceError("coingecko", "http", "CoinGecko did not answer"));
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
  const now = appNow();
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
  const listDue = now - stockListAt > (open ? 3 : 30) * 60e3 && (ui.tab === "home" || ui.tab === "markets" || BOTS.length > 0);
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
  if (SIM) {
    loop("clock", clockTick, 30e3, 60e3);
    loop("bots", botTick, 15e3, 60e3);
    simTimer = setInterval(simSecond, 1000);
    return;
  }
  loop("fx", fxLoop, 20e3, 90e3);
  fxRefLoad().then(() => kick("fx")).catch(noteError);
  loop("crypto", cryptoLoop, 30e3, 120e3);
  loop("cryptoHour", cryptoHourLoop, 120e3, 300e3);
  loop("meme", memeLoop, 10e3, 60e3);
  loop("stock", stockLoop, 60e3, 180e3);
  loop("clock", clockTick, 30e3, 60e3);
  loop("bots", botTick, 15e3, 60e3);
}

// ---------------------------------------------------------------- Sim mode
async function setMode(m) {
  if ((m === "sim") === SIM) return;
  toast(m === "sim" ? "🎰 Switching to Sim…" : "Switching to Live…");
  const saved = await saveOnExit();
  if (!saved) return; // the banner says why
  try { await kv.set("mode", m); } catch (e) { saveErr = e; renderBanners(); return; }
  location.reload();
}

const newWorld = () => SW.createWorld(TEST ? 12345 : Math.floor(Math.random() * 2147483647), Date.now());
async function loadSim() {
  REC = await loadClean("sim.records", (v, is) => CLEAN.cleanRecords(v, FUN.newRecords(), is));
  W = await loadClean("sim.world", (v, is) => (v && v.v === SW.VERSION ? CLEAN.cleanWorld(v, newWorld, is) : null));
  if (!W) W = newWorld();
  W.off = W.t - Date.now(); // the Sim clock continues exactly where it stopped
  bootAt = appNow();
  try { await loadPoints(); } catch (e) { console.warn("Rewind points", e?.message); PTS = []; FINE = []; lastPt = null; }
  W.off = W.t - Date.now(); bootAt = appNow();
  document.querySelector(".total-box small").textContent = "Your Sim portfolio";
  publishSim(false);
}

/** Push every Sim instrument to the app's live prices and lists (exactly what the real sources do in Live). */
function publishSim(check) {
  for (const i of Object.values(W.insts)) setLive(SW.instOf(i), SW.quote(W, i), { check });
  const L = SW.lists(W);
  lists.crypto = L.crypto; lists.stock = L.stock; lists.fx = L.fx;
  const memeSig = lists.meme.new.join(",");
  lists.meme.trending = L.trending; lists.meme.new = L.fresh;
  lists.memeAt.trending = lists.memeAt.new = appNow();
  return memeSig !== L.fresh.join(",");
}

function simSecond() {
  if (!W || document.hidden || skipping) return;
  // The Sim only moves while the app is open: after a pause the Sim clock moves back instead of skipping time.
  const gap = appNow() - W.t;
  if (gap > SW.MAX_GAP) W.off -= gap - 1000;
  simAdvance(appNow());
}

/** What the Sim must not drop: everything you, your orders, alerts and bots touch, plus the top trending coins. */
function simKeep() {
  const keep = new Set(trackedKeys());
  for (const k of lists.meme.trending.slice(0, 10)) keep.add(k);
  for (const k in signals()) keep.add(k);
  return keep;
}

/** Advance the Sim world to `now`, stopping at each second where an Oracle signal buys or sells. */
function simAdvance(now) {
  const out = [];
  for (let n = 0; n < 500; n++) {
    const t = autoNext();
    if (!(t > W.t && t < now)) break;
    out.push(...simStep(t));
    if (W.t < t) break; // a long pause is not simulated
    autoRun();
  }
  out.push(...simStep(now));
  autoRun();
  return out;
}
/** Advance the Sim world and react: prices, banners, effects, jackpots, rugs. */
function simStep(now) {
  if (now > appNow()) W.off += now - appNow(); // tests drive the Sim clock directly
  const mine = [...Object.values(S.pos), ...E.marginPositions(S)];
  const before = new Map(), pxBefore = new Map();
  for (const p of mine) {
    before.set(p.key, (before.get(p.key) || 0) + (E.positionValue(S, p, quoteFor(p.key)) || 0));
    pxBefore.set(p.key, live.get(p.key)?.px);
  }
  const keep = simKeep();
  const out = SW.step(W, now, { keep, lev: SW.leverageByKey([S]) });
  const changed = publishSim(true);
  for (const e of out) if (e.kind === "gone") for (const k of e.keys) if (!keep.has(k)) { live.delete(k); ticks.delete(k); }
  simEvents(out, before);
  // big moves in what you hold shake the screen
  for (const [k, px0] of pxBefore) {
    const px1 = live.get(k)?.px;
    if (px0 > 0 && px1 > 0 && Math.abs(px1 / px0 - 1) >= 0.08 && now - shakeAt > 2500) { shakeAt = now; shake($("#app")); vibrate(px1 > px0 ? [30, 30, 30] : 160); }
  }
  // jackpots: a position worth 10x its cost
  for (const j of FUN.newJackpots(mine, p => E.positionValue(S, p, quoteFor(p.key)))) { jpKeys.add(j.p.key); showJackpot(j.p.inst.sym, j.mult, j.usd, now); }
  addPoint();
  if (now - simSavedAt > 10e3) { simSavedAt = now; saveWorld(); }
  if (changed && ui.tab === "markets" && ui.market === "meme" && !lists.search.meme && now - simListAt > 3000) { simListAt = now; renderView(); }
  return out;
}

const heldKey = k => !!S.pos[k] || E.marginPositions(S).some(p => p.key === k);
const watching = k => heldKey(k) || (ui.sheet?.kind === "inst" && ui.sheet.key === k);
function simEvents(out, before = new Map()) {
  const now = appNow();
  for (const e of out) {
    const i = e.key ? W.insts[e.key] : null, sym = esc(i?.sym || "");
    if (e.kind === "event") {
      renderBanners(); shake($("#app")); vibrate([80, 50, 80, 50, 160]); sfx("event");
      const b = $(".sim-event"); if (b) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
    } else if (e.kind === "end") renderBanners();
    else if (e.kind === "rug" && heldKey(e.key)) {
      const after = [...Object.values(S.pos), ...E.marginPositions(S)].filter(p => p.key === e.key).reduce((a, p) => a + (E.positionValue(S, p, quoteFor(p.key)) || 0), 0);
      const lost = Math.max(0, (before.get(e.key) || 0) - after);
      FUN.onRug(REC, { sym: i.sym, usd: lost, pct: e.drop }, now); saveRec();
      bigResult($("#result"), { text: "RUG PULL", sub: `${sym} −${Math.round(e.drop * 100)}% · you lost ${$usd(lost)}`, win: false });
      shake($("#app")); vibrate([300, 80, 300]); sfx("rug");
    } else if (e.kind === "rug" && watching(e.key)) { toast(`💀 ${sym} got rugged: −${Math.round(e.drop * 100)}%`, "down"); sfx("rug"); }
    else if ((e.kind === "pump" || e.kind === "moonshot") && (watching(e.key) || e.kind === "moonshot")) {
      toast(e.kind === "moonshot" ? `🌕 MOONSHOT: ${sym} is going vertical` : `🚀 ${sym} is pumping`, "gold"); sfx("pump");
    } else if (e.kind === "whale" && watching(e.key)) {
      toast(`🐋 A whale ${e.up ? "bought" : "dumped"} ${sym}: ${$pct(e.move * 100, 0)}`, e.up ? "up" : "down");
      if (heldKey(e.key)) { shake($("#app")); vibrate(e.up ? [30, 30, 30] : 200); }
    } else if ((e.kind === "crash" || e.kind === "rally") && watching(e.key)) toast(e.kind === "crash" ? `📉 ${sym} is crashing` : `📈 ${sym} is rallying`, e.kind === "crash" ? "down" : "up");
    else if (e.kind === "news") toast(`📰 News: the ${esc(W.cur[e.cur].name)} ${e.move > 0 ? "jumps" : "drops"} ${pct(Math.abs(e.move) * 100, 1).replace("+", "")}`, e.move > 0 ? "up" : "down");
    else if (e.kind === "cascade") { toast(`💥 Liquidation cascade: ${$usd(e.usd, { compact: true })} of ${sym} longs liquidated`, "down"); shake($("#app")); vibrate([120, 40, 120]); sfx("loss"); }
  }
}

// ---------------------------------------------------------------- Oracle (cheat, Sim only)
const ORACLE_SECS = 30 * 60;
/** The next 30 minutes of this coin, played on a copy of the Sim world. Cached; replayed every 5 Sim minutes. */
function oracleFor(key) {
  if (!SIM || !W || !C.isOn(S, "oracle") || !W.insts[key]) return null;
  if (oracle && oracle.key === key && oracle.ver === oracleVer && W.t >= oracle.at && W.t < oracle.at + 5 * 60e3) return oracle;
  const g = signals()[key];
  if (autoOn()) {
    const a = forecast(key);
    const best = g ? { buy: { t: g.buyT, px: g.buyPx }, sell: { t: g.sellT, px: g.sellPx }, gain: g.sellPx / g.buyPx - 1 } : planFor(a, key);
    return (oracle = { key, at: W.t, ver: oracleVer - 1, inst: a.insts[key], best, until: a.t0 + ORACLE_SECS * 1000 });
  }
  const f = SW.future(W, key, ORACLE_SECS, { keep: simKeep(), lev: SW.leverageByKey([S]) });
  const wi = W.insts[key];
  oracle = { key, at: W.t, ver: oracleVer, inst: f.inst, best: g ? { buy: { t: g.buyT, px: g.buyPx }, sell: { t: g.sellT, px: g.sellPx }, gain: g.sellPx / g.buyPx - 1 } : SW.bestTrade(f.path, W.t, wi.px), until: W.t + ORACLE_SECS * 1000 };
  return oracle;
}

function oracleNote(o, inst) {
  const el = $("#oracleNote");
  if (!el) return;
  if (!o) { el.hidden = true; return; }
  el.hidden = false;
  const now = W.t, b = o.best;
  const when = t => (t <= now ? "now" : t - now < 60e3 ? `in ${Math.ceil((t - now) / 1000)} s` : `in ${countdown(t - now)}`);
  const g = signals()[inst.key];
  // the buttons stay in place between redraws, so a tap never lands on a replaced one
  if (!el.firstElementChild?.matches(".on-t")) el.innerHTML = `<div class="on-t"></div><div class="on-b"></div>`;
  const btns = g?.state === "held" ? `<button class="btn sm" data-jumpsell="${esc(inst.key)}">Jump to sell</button>`
    : g ? `<button class="btn sm ghost" data-disarm="${esc(inst.key)}">Cancel</button>`
    : b && b.sell.t > now ? `<button class="btn sm" data-doit="${esc(inst.key)}">Do it</button><button class="btn sm ghost" data-jumpbuy="${esc(inst.key)}">Jump to it</button>` : "";
  const bel = el.querySelector(".on-b");
  if (bel._h !== btns) { bel._h = btns; bel.innerHTML = btns; }
  const status = g?.state === "armed" ? ` · <b class="gold">Armed</b> ${$usd(g.usd)}, buys ${when(g.buyT)}` : g ? ` · <b class="gold">${g.src === "jump" ? "Bought" : "Armed"}</b>, ${g.src === "jump" ? "SELL is" : "sells"} ${g.sellT <= now ? "now" : when(g.sellT)}` : autoOn() ? ` · <b class="gold">Auto ${CFG.oracleAuto.pct}%</b>` : "";
  el.querySelector(".on-t").innerHTML = (b
    ? `🔮 <b>Oracle</b> · BUY ${b.buy.t <= now ? "now" : when(b.buy.t)} at ${$px(inst, b.buy.px)} · SELL = max profit ${b.sell.t <= now ? "passed" : when(b.sell.t)} at ${$px(inst, b.sell.px)} · <b class="up">${$pct(b.gain * 100, 1)}</b>`
    : `🔮 <b>Oracle</b> · no profitable trade in the next 30 minutes: it only goes down from here.`) + status;
}

// ---------------------------------------------------------------- Oracle Auto, "Do it" and "Jump to it"
// S.cheats.auto = {key: signal}. A signal: {src: auto | do | jump, state: armed | held, sym, usd, buyT, buyPx, sellT,
// sellPx, qty}. They live in the portfolio, so they survive closing the app and go back with a Rewind.
const signals = () => S.cheats?.auto || {};
const autoOn = () => SIM && CFG.oracleAuto.on && C.isOn(S, "oracle");
let fc = null;                // forecast of every coin: {t0, paths, insts, lev, plans}
let sigStale = false;         // the future changed (Skip ahead): signals need new times
const levSig = () => JSON.stringify(SW.leverageByKey([S]));
const simQ = key => { const i = W.insts[key]; return i ? { px: i.px, t: W.t, liq: i.liq, quoteUsd: i.m === "fx" ? W.cur[i.quote].usd : undefined } : null; };

function forecast(need) {
  const lev = levSig();
  if (!fc || fc.lev !== lev || W.t < fc.t0 || W.t >= fc.t0 + 5 * 60e3 || (need && W.insts[need] && !fc.paths[need]))
    fc = { ...SW.futureAll(W, ORACLE_SECS, { keep: simKeep(), lev: SW.leverageByKey([S]) }), lev, plans: {} };
  return fc;
}
/** What is left of the forecast of one coin: [[t, px]]. */
function pathLeft(f, key) {
  const a = f.paths[key], out = [];
  if (a) for (let n = Math.max(0, Math.round((W.t - f.t0) / 1000)); n < a.length && a[n] > 0; n++) out.push([f.t0 + (n + 1) * 1000, a[n]]);
  return out;
}
/** The next mark of a coin: {buy, sell, gain} or null. A mark in the past is replaced by the next one. */
function planFor(f, key) {
  const p = f.plans[key];
  if (p === null || (p && p.buy.t >= W.t)) return p;
  return (f.plans[key] = W.insts[key] ? SW.bestTrade(pathLeft(f, key), W.t, W.insts[key].px) : null);
}
/** Would this mark still win after commissions, spread and price impact? */
function paysOff(key, best, usd) {
  try {
    const i = W.insts[key], inst = SW.instOf(i), q = simQ(key), t = E.newPortfolio(W.t, 1e6);
    t.cash = usd;
    if (S.cheats) t.cheats = { on: { zeroFees: C.isOn(S, "zeroFees"), marketMaker: C.isOn(S, "marketMaker") }, armed: {}, log: [], lev: 1 };
    E.executeBuy(t, inst, usd, { ...q, px: best.buy.px }, W.t);
    return E.executeSell(t, key, 1, { ...q, px: best.sell.px }, W.t).pl > 0;
  } catch { return false; }
}
const autoKeys = () => (CFG.oracleAuto.scope === "all" ? Object.keys(W.insts) : ui.sheet?.kind === "inst" && W.insts[ui.sheet.key] ? [ui.sheet.key] : []);
/** The next moment a signal has something to do (Sim time), or Infinity. */
function autoNext() {
  let t = Infinity;
  for (const g of Object.values(signals())) if (g.state === "armed") t = Math.min(t, g.buyT); else if (g.src !== "jump") t = Math.min(t, g.sellT);
  if (autoOn()) { const keys = autoKeys(), f = keys.length ? forecast(CFG.oracleAuto.scope === "view" ? keys[0] : null) : null; for (const k of keys) { if (signals()[k]) continue; const p = planFor(f, k); if (p) t = Math.min(t, p.buy.t > W.t ? p.buy.t : Infinity); } }
  return t;
}
function dropSignal(key, why) {
  const g = signals()[key];
  delete S.cheats.auto[key];
  if (why && g) toast(`🔮 ${esc(g.sym)}: ${why}`, "down");
  saveSoon(0);
}
function signalBuy(key, g, usd) {
  usd = Math.floor(Math.min(usd, E.available(S)) * 100) / 100;
  if (!(usd >= 1)) throw new E.TradeError("not enough cash for the signal.");
  const t = E.executeBuy(S, SW.instOf(W.insts[key]), usd, simQ(key), W.t, "oracle", false, { tags: ["Oracle"] });
  const st = C.state(S);
  (st.auto ||= {})[key] = { ...g, state: "held", qty: t.qty };
  C.mark(S, "oracle", `Oracle bought ${t.sym} for $${usd.toFixed(2)}`, W.t);
  return t;
}
function signalSell(key, g) {
  const p = S.pos[key];
  delete S.cheats.auto[key];
  if (fc) delete fc.plans[key];
  if (!p) return null;
  const t = E.executeSell(S, key, Math.min(1, g.qty / p.qty), simQ(key), W.t, "oracle", { tags: ["Oracle"] });
  C.mark(S, "oracle", `Oracle sold ${t.sym}`, W.t);
  return t;
}
/** After a Skip ahead or a leverage change the future is another one: give every signal its new times. */
function refreshSignals() {
  const lev = levSig(), keys = Object.keys(signals());
  if (!keys.length) { sigStale = false; return; }
  if (!sigStale && S.cheats.autoLev === lev) return;
  sigStale = false; S.cheats.autoLev = lev;
  const f = forecast();
  for (const key of keys) {
    const g = signals()[key], i = W.insts[key];
    if (!i) { dropSignal(key, "the coin is gone, so the signal was canceled."); continue; }
    if (g.state === "armed") {
      const b = planFor(f, key);
      if (!b) { dropSignal(key, "the future changed and there's no profitable trade now. Signal canceled."); continue; }
      Object.assign(g, { buyT: b.buy.t, buyPx: b.buy.px, sellT: b.sell.t, sellPx: b.sell.px });
    } else {
      let top = [W.t, i.px];
      for (const x of pathLeft(f, key)) if (x[1] > top[1]) top = x;
      g.sellT = top[0]; g.sellPx = top[1];
    }
  }
}
/** Buy and sell whatever is due at this second. Returns the trades. */
function autoTrades() {
  if (!SIM || !W) return [];
  const out = [], on = autoOn();
  if (!on && !Object.keys(signals()).length) return out;
  refreshSignals();
  for (const [key, g] of Object.entries(signals())) {
    try {
      if (!W.insts[key]) dropSignal(key, "the coin is gone, so the signal was canceled.");
      else if (g.state === "held") {
        if (!S.pos[key]) dropSignal(key);                       // you already sold it
        else if (g.src !== "jump" && W.t >= g.sellT) { const t = signalSell(key, g); if (t) out.push(t); }
      } else if (W.t >= g.sellT) dropSignal(key, "the signal is over.");
      else if (W.t >= g.buyT) out.push(signalBuy(key, g, g.usd));
    } catch (e) { dropSignal(key, esc(e.message)); }
  }
  if (on) {
    const keys = autoKeys(), f = keys.length ? forecast(CFG.oracleAuto.scope === "view" ? keys[0] : null) : null;
    for (const key of keys) {
      if (signals()[key]) continue;
      const best = planFor(f, key);
      if (!best || best.buy.t > W.t) continue;
      const usd = E.available(S) * CFG.oracleAuto.pct / 100;
      if (usd < 1) break;
      if (!paysOff(key, best, usd)) { f.plans[key] = null; continue; } // costs would eat the gain
      try {
        out.push(signalBuy(key, { src: "auto", sym: W.insts[key].sym, buyT: best.buy.t, buyPx: best.buy.px, sellT: best.sell.t, sellPx: best.sell.px }, usd));
        S.cheats.autoLev = levSig();
      } catch { f.plans[key] = null; }
    }
  }
  return out;
}
function autoNotice(trades) {
  if (!trades.length) return;
  const one = t => (t.side === "buy" ? `bought ${$usd(t.usd)} of ${esc(t.sym)}` : `sold ${esc(t.sym)}: ${$usd(t.pl, { sign: true })}`);
  toast("🔮 Oracle " + trades.slice(0, 3).map(one).join(" · ") + (trades.length > 3 ? ` · and ${trades.length - 3} more` : ""), trades.some(t => t.side === "sell" && t.pl < 0) ? "down" : "up");
  if (!skipping) afterTrades(trades);
  drawChartSoon();
}
function autoRun() { const t = autoTrades(); autoNotice(t); return t; }

/** The amount for a signal: what you chose in the buy box, or 10% of your cash. */
function signalUsd(key) {
  const sh = ui.sheet;
  const usd = sh?.kind === "inst" && sh.key === key && sh.amtSet && sh.amount > 0 ? sh.amount : E.available(S) * 0.1;
  return Math.floor(Math.min(usd, E.available(S)) * 100) / 100;
}
function newSignal(key, src) {
  const o = oracleFor(key), b = o?.best;
  if (!b || signals()[key] || W.t >= b.sell.t) return null;
  const usd = signalUsd(key);
  if (!(usd >= 1)) { toast("Not enough cash for this signal.", "down"); return null; }
  const st = C.state(S);
  st.autoLev = levSig();
  return { src, state: "armed", sym: W.insts[key].sym, usd, buyT: b.buy.t, buyPx: b.buy.px, sellT: b.sell.t, sellPx: b.sell.px };
}
function doIt(key) {
  if (skipping) return;
  const g = newSignal(key, "do");
  if (!g) return;
  (C.state(S).auto ||= {})[key] = g;
  C.mark(S, "oracle", `Oracle: armed ${g.sym} with $${g.usd.toFixed(2)}`, W.t);
  toast(`🔮 Armed: ${esc(g.sym)} with ${$usd(g.usd)}`, "gold");
  autoRun();
  cheatChanged(); drawChartSoon(true);
}
async function jumpBuy(key) {
  if (skipping) return;
  const g = newSignal(key, "jump");
  if (!g) return;
  (C.state(S).auto ||= {})[key] = g; // keeps the coin alive on the way; bought on arrival
  C.mark(S, "oracle", `Jump to it: ${g.sym}`, W.t);
  if (g.buyT > W.t) await jumpTo(g.buyT, `to BUY ${esc(g.sym)}`);
  autoRun();
  cheatChanged(); renderSheet(); drawChartSoon(true);
}
async function jumpSell(key) {
  const g = signals()[key];
  if (skipping || g?.state !== "held") return;
  C.mark(S, "oracle", `Jump to sell: ${g.sym}`, W.t);
  if (g.sellT > W.t) await jumpTo(g.sellT, `to SELL ${esc(g.sym)}`);
  if (signals()[key]) try { const t = signalSell(key, signals()[key]); if (t) { celebrate(t); autoNotice([t]); } } catch (e) { toast(esc(e.message), "down"); }
  cheatChanged(); renderSheet(); drawChartSoon(true);
}
/** Second by second, exactly as the Oracle played it. */
async function jumpTo(t, label) {
  const n = Math.round((t - W.t) / 1000);
  if (n > 0) await playAhead([{ dt: 1, n }], `Jumping ${label}…`, true);
}

// ---------------------------------------------------------------- Rewind (cheat, Sim only)
let FINE = [], PTS = [], lastPt = null, ptQueue = [], ptWarned = false; // PTS: [{t, key}], oldest first; FINE: [{t, base}]
const ptKey = t => "sim.pt." + t, fineKey = t => "sim.fpt." + t;
const ptIndex = () => ["sim.points", { pts: PTS, fine: FINE }];
/** The save point to go back to: the newest one at or before `target`, fine or main. */
function findPoint(target) {
  const i = RW.pointAt(PTS, target), f = FINE[RW.pointAt(FINE, target)];
  return f && PTS.some(p => p.t === f.base) && (i < 0 || f.t > PTS[i].t) ? { t: f.t, fine: f } : i < 0 ? null : { t: PTS[i].t };
}
let ptEnd = 0; // while playing ahead: where it ends (fine points only near the end)
function addPoint(force = false) {
  if (!W) return;
  const last = PTS[PTS.length - 1];
  if (last && W.t <= last.t) return;
  if (last && !force && W.t - last.t < RW.EVERY) {
    const lf = Math.max(last.t, FINE[FINE.length - 1]?.t || 0);
    if (!lastPt || W.t - lf < RW.FINE_EVERY || (skipping && ptEnd - W.t > RW.FINE_KEEP)) return;
    ptQueue.push({ ...RW.makePoint(W, S, BOTS, lastPt), fine: true });
    FINE.push({ t: W.t, base: last.t });
    if (!skipping) flushPoints();
    return;
  }
  const p = RW.makePoint(W, S, BOTS, lastPt && lastPt.n + 1 < RW.KEY_EVERY ? lastPt : null);
  lastPt = p;
  PTS.push({ t: p.t, key: p.key });
  ptQueue.push(p);
  if (!skipping) flushPoints();
}
async function flushPoints() {
  if (!ptQueue.length) return;
  const q = ptQueue, old = RW.expired(PTS, W.t), oldF = FINE.filter(p => p.t < W.t - RW.FINE_KEEP);
  ptQueue = [];
  FINE = FINE.slice(oldF.length);
  PTS = PTS.slice(old.length);
  try { await kv.setMany([...q.map(p => [(p.fine ? fineKey : ptKey)(p.t), p]), ...old.map(p => [ptKey(p.t), undefined]), ...oldF.map(p => [fineKey(p.t), undefined]), ptIndex()]); }
  catch (e) {
    console.warn("Rewind point not saved", e?.message);
    const bad = new Set(q.map(p => p.t));
    PTS = PTS.filter(p => !bad.has(p.t)); FINE = FINE.filter(p => !bad.has(p.t)); lastPt = null; // the next one is complete, so no chain is broken
    if (!ptWarned) { ptWarned = true; toast("⚠️ A Rewind point couldn't be saved (no space?). Your portfolio is saved apart.", "down"); }
  }
}
async function loadPoints() {
  const saved = await kv.get("sim.points"), good = x => (Array.isArray(x) ? x.filter(p => CLEAN.num(p?.t)) : []);
  PTS = good(saved?.pts); FINE = good(saved?.fine);
  const keep = PTS.filter(p => p.t <= W.t), gone = PTS.filter(p => p.t > W.t); // written just before a sudden close
  const last = keep.length ? await kv.get(ptKey(keep[keep.length - 1].t)) : null;
  if (keep.length && (!last || last.world.created !== W.created)) { await clearPoints(); }
  else {
    const goneF = FINE.filter(p => p.t > W.t);
    PTS = keep; lastPt = last; FINE = FINE.filter(p => p.t <= W.t);
    if (gone.length || goneF.length) await kv.setMany([...gone.map(p => [ptKey(p.t), undefined]), ...goneF.map(p => [fineKey(p.t), undefined]), ptIndex()]);
  }
  addPoint();
}
async function clearPoints() {
  const old = PTS, oldF = FINE;
  PTS = []; FINE = []; lastPt = null; ptQueue = [];
  await kv.setMany([...old.map(p => [ptKey(p.t), undefined]), ...oldF.map(p => [fineKey(p.t), undefined]), ptIndex()]);
}
async function rewind(id) {
  const ms = RW.REWINDS[id];
  if (!SIM || !W || skipping || !ms) return;
  if (!findPoint(W.t - ms)) { toast(PTS.length ? `No save point that far back. The oldest is ${dateTime(PTS[0].t)} (Sim).` : "There are no save points yet.", "down"); return; }
  skipping = true;
  const before = { W, S, BOTS, PTS, FINE, lastPt, bootAt };
  try {
    await flushPoints();
    const pt = findPoint(W.t - ms);
    if (!pt) throw new Error("that save point is gone.");
    const j = RW.pointAt(PTS, pt.fine ? pt.fine.base : pt.t);
    const chain = [];
    for (const p of RW.chainOf(PTS, j)) { const r = await kv.get(ptKey(p.t)); if (!r) throw new Error("a save point is damaged."); chain.push(r); }
    const main = chain[chain.length - 1];
    if (pt.fine) { const r = await kv.get(fineKey(pt.t)); if (!r) throw new Error("a save point is damaged."); chain.push(r); }
    const from = W.t, to = pt.t;
    const back = RW.carryOver(RW.restore(chain), S, BOTS, to);
    const gone = PTS.slice(j + 1), goneF = FINE.filter(p => p.t > to);
    W = back.w; S = back.s; S.undoable = true; BOTS = back.bots; bootAt = W.t;
    PTS = PTS.slice(0, j + 1); lastPt = main; FINE = FINE.filter(p => p.t <= to);
    C.mark(S, "rewind", `Rewind ${id}: back to ${dateTime(to)} (Sim)`, W.t);
    const keys = ["portfolio", "world", "bots"];
    checkData(keys);
    await kv.setMany([...keys.map(k => VALUES[k]()), ...gone.map(p => [ptKey(p.t), undefined]), ...goneF.map(p => [fineKey(p.t), undefined]), ptIndex()]);
    W.off = W.t - Date.now(); simSavedAt = W.t;
    fc = null; oracle = null; oracleVer++; sigStale = true; shakeAt = 0; simListAt = 0;
    jpKeys.clear(); capSeen = -1; lastTotal = null;
    for (const k of [...live.keys()]) if (!W.insts[k]) live.delete(k);
    ticks.clear();
    hideLastChance();
    skipping = false;
    publishSim(false);
    if (ui.sheet?.kind === "inst" && !W.insts[ui.sheet.key]) closeSheet(true);
    renderAll(); refreshStandings(); renderSheet(); drawChartSoon(true); showSaved(); frame();
    toast(`⏪ Back to ${dateTime(to)} (Sim clock, −${countdown(from - to)}) ★`, "gold");
    return { from, to };
  } catch (e) {
    ({ W, S, BOTS, PTS, FINE, lastPt, bootAt } = before);
    W.off = W.t - Date.now();
    toast(`Could not rewind: ${esc(e.message || "error")}`, "down");
  } finally { skipping = false; }
}

/**
 * Skip ahead (Sim only): play the whole Sim world forward by 1 hour, 1 day or 1 week. Candles, events, new coins,
 * rugs and the bots' trades happen as if the time had passed; your limit orders, stop loss, take profit and
 * trailing stop fill on the way at the prices of that moment.
 */
async function skipAhead(id) {
  const ms = SW.SKIPS[id];
  if (!SIM || !W || skipping || !ms) return;
  const label = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour", "1d": "1 day", "1w": "1 week" }[id];
  return playAhead(SW.skipPlan(ms), `Skipping ahead ${label}…`, false, label);
}
/** exact: 1-second steps that follow the Oracle (Jump to it); no summary at the end. */
async function playAhead(plan, title, exact, label = "") {
  addPoint(true);
  skipping = true;
  hideLastChance();
  const box = $("#skipBox");
  box.innerHTML = `<div class="skip-box"><b>⏩ ${title}</b><div class="bar"><i id="skipBar"></i></div><small id="skipTxt">Generating candles, events and the bots' moves</small></div>`;
  box.hidden = false;
  const total0 = E.totals(S, quoteFor).total, t0 = W.t;
  const tally = { events: {}, coin: 0, pump: 0, moonshot: 0, rug: 0, cascade: 0, news: 0 };
  const mine = [], botMade = [];
  const OPEN = { open: true, since: 0 };
  const trail = trailPct();
  const steps = plan.reduce((a, x) => a + x.n, 0);
  const endT = W.t + plan.reduce((a, x) => a + x.n * x.dt * 1000, 0);
  ptEnd = endT;
  let done = 0, sinceBots = 0, yieldAt = performance.now();
  try {
    for (const seg of plan) {
      for (let k = 0; k < seg.n; k++) {
        const keep = simKeep();
        const out = SW.stepBy(W, seg.dt, { keep, lev: SW.leverageByKey([S]) });
        for (const e of out) {
          if (e.kind === "event") tally.events[e.ev.title] = (tally.events[e.ev.title] || 0) + 1;
          else if (e.kind in tally) tally[e.kind]++;
          else if (e.kind === "gone") for (const g of e.keys) if (!keep.has(g)) { live.delete(g); ticks.delete(g); }
        }
        const now = W.t;
        const mineKeys = new Set([...Object.keys(S.pos), ...E.marginPositions(S).map(x => x.key), ...S.orders.map(o => o.key)]);
        for (const key of mineKeys) {
          const wi = W.insts[key];
          if (!wi) continue;
          const q = { px: wi.px, t: now, liq: wi.liq, quoteUsd: wi.m === "fx" ? W.cur[wi.quote].usd : undefined };
          mine.push(...E.checkKey(S, key, q, now, OPEN, { trail }));
        }
        if (exact && W.t < endT) for (const trade of autoTrades()) mine.push({ type: "oracle", trade });
        addPoint();
        if (ptQueue.length >= 8) await flushPoints();
        sinceBots += seg.dt;
        if (BOTS.length && sinceBots >= 60) {
          sinceBots = 0;
          const entries = Object.values(W.insts).map(i => ({ inst: SW.instOf(i), ...SW.quote(W, i) }));
          for (const b of BOTS) {
            botCheatTick(b, now, { allowed: CFG.botCheats, quoteFor: k => { const i = W.insts[k]; return i ? { px: i.px, t: now, liq: i.liq, quoteUsd: i.m === "fx" ? W.cur[i.quote].usd : undefined } : null; } });
            for (const t of botStep(b, { entries, now, status: () => OPEN, bootAt, extreme: botExtreme, cheats: CFG.botCheats })) botMade.push([b, t]);
          }
        }
        done++;
        if (performance.now() - yieldAt > 50) {
          $("#skipBar").style.width = Math.round((done / steps) * 100) + "%";
          $("#skipTxt").textContent = `${dateTime(now)} (Sim) · ${tally.coin.toLocaleString("en-US")} new coins, ${tally.rug} rugs`;
          await new Promise(r => setTimeout(r, 0));
          yieldAt = performance.now();
        }
      }
    }
  } finally {
    W.off = W.t - Date.now();
    skipping = false;
  }
  flushPoints();
  if (!exact) { sigStale = true; fc = null; }
  oracleVer++;
  publishSim(false);
  const trades = mine.filter(e => e.trade).map(e => e.trade);
  const count = type => mine.filter(e => e.type === type).length;
  for (const p of [...Object.values(S.pos), ...E.marginPositions(S)]) if (!p.jackpot && p.cost > 0) { const v = E.positionValue(S, p, quoteFor(p.key)); if (v / p.cost >= FUN.JACKPOT_X) p.jackpot = true; }
  if (trades.length) afterTrades(trades); else saveSoon(0);
  if (botMade.length) saveBots(false);
  saveWorld(); simSavedAt = W.t;
  if (exact) { box.hidden = true; renderBanners(); renderView(); refreshStandings(); frame(); return { tally, mine, botMade }; }
  const total1 = E.totals(S, quoteFor).total;
  const evs = Object.entries(tally.events).map(([k, n]) => esc(k) + (n > 1 ? ` ×${n}` : "")).join(", ") || "none";
  const yours = [[count("fill"), "order filled", "orders filled"], [count("sl"), "stop loss", "stop losses"], [count("tp"), "take profit", "take profits"], [count("trail"), "trailing stop", "trailing stops"], [count("liq"), "liquidation", "liquidations"], [count("cancel"), "order canceled", "orders canceled"]]
    .filter(([n]) => n).map(([n, a, b]) => plural(n, a, b)).join(", ") || "nothing triggered";
  box.innerHTML = `<div class="skip-box done" role="dialog" aria-labelledby="skipT">
    <b id="skipT">⏩ +${label}</b><small>Sim clock: ${dateTime(t0)} → <b>${dateTime(W.t)}</b></small>
    <ul>
      <li><span>Events</span><b>${evs}</b></li>
      <li><span>Memecoins</span><b>${tally.coin.toLocaleString("en-US")} new · ${tally.pump} pumps · ${tally.moonshot} moonshots · ${tally.rug} rugs</b></li>
      <li><span>Your orders</span><b>${yours}</b></li>
      <li><span>Rival bots</span><b>${botMade.length ? plural(botMade.length, "trade", "trades") : "no trades"}</b></li>
      <li><span>Your Sim portfolio</span><b>${$usd(total0)} → <span class="${dirCls(total1 - total0)}">${$usd(total1)}</span></b></li>
    </ul>
    <button class="btn" data-skipok>OK</button></div>`;
  renderBanners(); renderView(); refreshStandings();
  if (ui.sheet?.kind === "inst") { renderSheet(); drawChartSoon(true); }
  frame();
  for (const k of trackedKeys()) lastChanceCheck(k);
  return { tally, mine, botMade };
}

function simEventHTML() {
  const ev = W?.event;
  if (!ev || appNow() > ev.until) return "";
  return `<div class="sim-event ev-${ev.type}" role="status"><span class="se-i" aria-hidden="true">${ev.icon}</span><div class="se-t"><b>${esc(ev.title)}</b><small>${esc(ev.text)}</small></div><b class="se-cd" data-cd="${ev.until}">${countdown(ev.until - appNow())}</b></div>`;
}

function showJackpot(sym, mult, gain, now) {
  FUN.onJackpot(REC, { sym, mult, usd: gain }, now); saveRec();
  jackpotFx($("#jackpot"), { mult: mult.toFixed(1) + "x", sym: esc(sym), usd: usd(gain, { sign: true }) });
  confetti($("#confetti"), { big: true }); shake($("#app")); vibrate([100, 50, 100, 50, 100, 50, 400]); sfx("jackpot");
}

function simAfterTrades(trades) {
  const now = appNow();
  for (const t of trades) {
    if (t.side !== "sell" || t.reason === "bot" || t.ghosted) continue;
    const r = FUN.onSale(REC, t, now);
    if (r.up && r.mult > 1) { const el = $("#combo"); updateCombo(); el?.classList.remove("pop"); void el?.offsetWidth; el?.classList.add("pop"); }
    else if (r.broke) toast("Combo broken 💔");
    if (t.plPct >= FUN.JACKPOT_X - 1 && !jpKeys.has(t.key)) showJackpot(t.sym, t.plPct + 1, t.pl, now);
    if (!S.pos[t.key]) jpKeys.delete(t.key);
  }
  saveRec();
}

function updateCombo() {
  const el = $("#combo");
  if (!el) return;
  const n = SIM && REC ? REC.wins : 0;
  el.hidden = n < 2;
  if (n >= 2) el.innerHTML = `🔥 COMBO x${FUN.comboMult(n)} <small>${n} wins in a row</small>`;
}

function recordsHTML() {
  const r = REC || FUN.newRecords();
  return `<h2>Sim records</h2><div class="sb-grid card rec">
    <div><small>Best multiplier</small><b class="gold">${r.combo ? "x" + r.combo.x : "—"}</b><small>${r.combo ? plural(r.combo.n, "win", "wins") + " in a row" : "Win sales in a row"}</small></div>
    <div><small>Biggest jackpot</small><b class="gold">${r.jackpot ? r.jackpot.mult.toFixed(1) + "x" : "—"}</b><small>${r.jackpot ? esc(r.jackpot.sym) + " · " + usd(r.jackpot.usd, { sign: true }) : "A position worth 10x"}</small></div>
    <div><small>Worst rug</small><b class="${r.rug ? "down" : ""}">${r.rug ? usd(-r.rug.usd) : "—"}</b><small>${r.rug ? esc(r.rug.sym) + " · −" + Math.round(r.rug.pct * 100) + "%" : "A rug on a coin you hold"}</small></div>
    <div><small>Longest streak</small><b>${r.streak ? plural(r.streak.n, "win", "wins") : "—"}</b><small>${r.wins ? "Now: " + r.wins + " in a row" : "Sales in the green in a row"}</small></div>
  </div>`;
}

// ---------------------------------------------------------------- rival bots

/** Every bot takes a turn with the live prices the app has right now. Only while the app is on screen. */
function botTick(now = appNow()) {
  if (!BOTS.length || skipping || (document.hidden && !TEST)) return [];
  const entries = [...live.values()].map(L => ({ ...L, inst: L.inst }));
  const made = [];
  let cheated = 0;
  for (const b of BOTS) {
    cheated += botCheatTick(b, now, { allowed: CFG.botCheats, quoteFor }).length;
    const trades = botStep(b, { entries, now, status: m => mstatus(m, now), bootAt: TEST ? 0 : bootAt, extreme: botExtreme, cheats: CFG.botCheats });
    for (const t of trades) made.push([b, t]);
  }
  if (made.length || cheated) saveBots(false);
  refreshStandings();
  if (ui.sheet?.kind === "bot") renderSheet();
  return made;
}

/**
 * Lowest / highest price of `key` since `from`, for the bots' Golden entry and Perfect exit. Sim: its 1-minute
 * candles. Live: the live prices this app has seen (bots only trade while the app is open). null when unknown.
 */
function botExtreme(key, from, kind) {
  let xs = [];
  if (SIM) { const wi = W?.insts[key]; if (wi) for (const b of wi.b1) if (b[0] + 60e3 > from) xs.push(kind === "low" ? b[3] : b[2]); }
  else xs = (ticks.get(key) || []).filter(x => x.t >= from).map(x => x.px);
  if (!xs.length) return null;
  return kind === "low" ? Math.min(...xs) : Math.max(...xs);
}

function refreshStandings() {
  for (const id of ["lbSlot", "lbSlotFull"]) { const el = document.getElementById(id); if (el) el.innerHTML = leaderboardHTML(); }
  const feed = $("#botFeed"); if (feed) feed.innerHTML = botFeedHTML();
}

function participants() {
  const me = { id: "me", name: "You", cheat: E.isCheated(S), ...standing(S, quoteFor) };
  return [me, ...BOTS.map(b => ({ id: b.id, name: b.name, style: b.style, cheat: E.isCheated(b.pf), ...standing(b.pf, quoteFor) }))].sort((a, b) => b.plPct - a.plPct);
}

function leaderboardHTML() {
  const medal = ["🥇", "🥈", "🥉"];
  const tr = (label, t) => t ? `${label} <span class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })}</span> ${esc(t.sym)}` : `${label} —`;
  return `<div class="list">${participants().map((x, i) => `
    <button class="row lb ${x.id === "me" ? "me" : ""}" ${x.id === "me" ? `data-tab="history"` : `data-bot="${esc(x.id)}"`}>
      <span class="ico ico-rank" aria-label="Rank ${i + 1}">${medal[i] || i + 1}</span>
      <span class="nm"><b>${esc(x.name)}${x.cheat ? ` <span class="star" title="Cheats used">★</span>` : ""}${x.style && !x.name.startsWith(STYLES[x.style].name) ? ` <i class="mk-tag">${STYLES[x.style].name}</i>` : ""}</b><small>${tr("Best", x.best)}</small><small>${tr("Worst", x.worst)}</small>${x.id !== "me" && C.isOn(S, "xray") ? `<small class="xray">${xrayText(x.id)}</small>` : ""}</span>
      <span class="px"><b>${$usd(x.total)}</b><small class="${dirCls(x.pl)}">${$pct(x.plPct * 100)}</small></span>
    </button>${x.id !== "me" && C.isOn(S, "xray") ? frontBtns(x.id) : ""}`).join("")}</div>${BOTS.length && C.isOn(S, "xray") ? frontPctHTML() : ""}`;
}
const frontPctHTML = () => `<div class="chips front-pct"><small>Front-run with</small>${[5, 10, 25, 50, 100].map(n => `<button data-frpct="${n}" aria-pressed="${CFG.frontPct === n}">${n}%</button>`).join("")}<small>of your cash</small></div>`;
function nextMoves(b) {
  return botPreview(b, { entries: [...live.values()], now: appNow(), status: m => mstatus(m, appNow()), bootAt: TEST ? 0 : bootAt });
}
/** Front-run / Sell first, next to a bot's X-ray line. */
function frontBtns(id) {
  const b = BOTS.find(x => x.id === id);
  if (!b) return "";
  const v = nextMoves(b), out = [];
  if (v.buy) out.push(`<button class="btn sm" data-front="${esc(id)}" data-key="${esc(v.buy.key)}">Front-run ${esc(v.buy.sym)}</button>`);
  for (const s of v.sells) out.push(`<button class="btn sm ghost" data-sellfirst="${esc(id)}" data-key="${esc(s.key)}" ${S.pos[s.key] ? "" : "disabled"}>Sell first ${esc(s.sym)}</button>`);
  return out.length ? `<div class="front">${out.join("")}</div>` : "";
}
/** Buy (or sell) the coin of the bot's next move right now, before it does. */
function frontRun(id, sell, key) {
  const b = BOTS.find(x => x.id === id), inst = instOf(key);
  if (!b || !inst || !C.isOn(S, "xray") || skipping) return;
  try {
    const now = appNow(), q = quoteFor(key);
    if (!mstatus(inst.m, now).open) throw new E.TradeError("The market is closed.");
    const opts = { tags: [sell ? "Sell first" : "Front-run"] };
    let t;
    if (sell) {
      if (!S.pos[key]) throw new E.TradeError("You don't hold this coin.");
      t = E.executeSell(S, key, 1, q, now, "front", opts);
    } else {
      const usd = Math.floor(E.available(S) * CFG.frontPct) / 100;
      if (!(usd >= 1)) throw new E.TradeError("Not enough cash.");
      t = E.executeBuy(S, inst, usd, q, now, "front", false, opts);
    }
    C.mark(S, "xray", sell ? `Sold ${t.sym} before ${b.name}` : `Front-ran ${b.name} on ${t.sym}`, now);
    toast(sell ? `🩻 Sold ${esc(t.sym)} before ${esc(b.name)}: ${$usd(t.pl, { sign: true })}` : `🩻 Bought ${$usd(t.usd)} of ${esc(t.sym)} before ${esc(b.name)}`, "up");
    afterTrades([t]); refreshStandings();
  } catch (e) { toast(esc(e.message), "down"); }
}

/** X-ray: a dry run of the bot's next turn with the live prices the app has now. */
function xrayText(id) {
  const b = BOTS.find(x => x.id === id);
  if (!b) return "";
  const v = nextMoves(b);
  const parts = v.sells.map(x => `sell ${esc(x.sym)} (${esc(x.why)})`);
  if (v.buy) parts.push(`buy ${esc(v.buy.sym)} ~${$usd0(Math.round(v.buy.usd))} (${esc(v.buy.why)})${v.wait > 0 ? ` in ${Math.ceil(v.wait / 1000)} s` : ""}`);
  return "🩻 " + (parts.length ? "Next: " + parts.join(" · ") : "Nothing it would buy right now");
}

function botFeedHTML() {
  const trades = BOTS.flatMap(b => b.pf.trades.slice(-5).map(t => ({ b, t: t.t, tr: t })));
  const cheats = botCheatFeed(BOTS, 4).map(x => ({ b: x.bot, t: x.t, ch: x }));
  const recent = [...trades, ...cheats].sort((a, b) => b.t - a.t).slice(0, 5);
  if (!recent.length) return `<div class="empty sm">The bots trade only while the app is open. Their first moves show up here.</div>`;
  return `<div class="list">${recent.map(x => x.ch
    ? `<button class="feed cheat" data-bot="${esc(x.b.id)}"><b>${esc(x.b.name)} <span class="star">★</span></b> used a cheat: ${esc(x.ch.text)} <small>${clock(x.t)}</small></button>`
    : `<button class="feed" data-bot="${esc(x.b.id)}"><b>${esc(x.b.name)}</b> ${sideLabel(x.tr) === "short" ? "shorted" : x.tr.side === "buy" ? (x.tr.lev > 1 ? `bought ${x.tr.lev}x` : "bought") : "sold"} ${esc(x.tr.sym)} · ${$usd(x.tr.usd)}${x.tr.side === "sell" ? ` · <span class="${dirCls(x.tr.pl)}">${$usd(x.tr.pl, { sign: true })}</span>` : ""}${x.tr.cheat?.length ? ` <span class="star" title="${esc(x.tr.cheat.join(", "))}">★</span>` : ""} <small>${clock(x.t)}</small></button>`).join("")}</div>`;
}

function rivalsHome() {
  if (!BOTS.length) return "";
  return `<h2>Leaderboard</h2><div id="lbSlot">${leaderboardHTML()}</div><h2>Rival moves</h2><div id="botFeed">${botFeedHTML()}</div>`;
}

function addBot(style) {
  if (BOTS.length >= MAX_BOTS || !STYLES[style]) return;
  const now = appNow();
  const b = newBot(style, { id: "bot" + now.toString(36) + Math.floor(Math.random() * 1296).toString(36), name: botName(style, BOTS), start: S.start, now, seed: Math.floor(Math.random() * 2147483647) });
  BOTS.push(b); saveBots();
  toast(`🤖 ${b.name} joined with ${$usd0(b.pf.start)}`, "up");
  kick("meme"); kick("stock");
}

/** Bots restart with the owner's starting balance (same-size race). */
function resetBots(start, now) {
  BOTS = BOTS.map(b => ({ ...b, pf: E.newPortfolio(now, start), lastBuy: 0 }));
  saveBots();
}

function botSheetHTML(b) {
  const x = standing(b.pf, quoteFor);
  const tr = t => t ? `<b class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })}</b><small>${esc(t.sym)} · ${$pct(t.plPct * 100, 1)}</small>` : "<b>—</b>";
  const pos = Object.values(b.pf.pos).sort((a, c) => c.cost - a.cost).map(p => {
    const v = E.positionView(p, quoteFor(p.key));
    return `<button class="row" data-open="${esc(p.key)}">${icon(p.inst)}
      <span class="nm"><b>${esc(p.inst.sym)} <i class="mk-tag">${MARKET_LABEL[p.inst.m]}</i></b><small>Invested ${$usd(p.cost)}${v.live ? "" : " · last saved price"}</small></span>
      <span class="px"><b>${$usd(v.value)}</b><small class="${dirCls(v.pl)}">${$usd(v.pl, { sign: true })} (${$pct(v.plPct * 100, 1)})</small></span></button>`;
  }).join("");
  const hist = b.pf.trades.slice().reverse().slice(0, 200).map(t => tradeItem(t)).join("");
  return `<div class="sh-head"><span class="ico ico-bot" aria-hidden="true">🤖</span><div class="sh-title"><h2>${esc(b.name)}</h2><small>${STYLES[b.style].name} · rival bot</small></div>
      <button class="close" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">
      <div class="big">${$usd(x.total)}</div>
      <div class="chg"><span class="${dirCls(x.pl)}">${$usd(x.pl, { sign: true })} (${$pct(x.plPct * 100)})</span> from ${$usd0(b.pf.start)}</div>
      <p class="foot">${esc(STYLES[b.style].desc)} It trades only while the app is open, with the same costs and market hours as you. ${CFG.botCheats ? "It arms cheats from the bots' list (Settings → Rival bots) whenever they suit it; Money printer once a day." : "Bot cheats are off in Settings."}${E.isCheated(b.pf) ? ` ★ It has cheated: ${esc((b.pf.cheats.log || []).slice(-3).map(x => x.text).join(" · "))}` : ""}</p>
      ${C.isOn(S, "xray") ? `<p class="xray card">${xrayText(b.id)}</p>${frontBtns(b.id)}${frontPctHTML()}` : ""}
      <div class="sb-grid card">
        <div><small>Cash</small><b>${$usd(b.pf.cash)}</b></div>
        <div><small>Win rate</small><b>${x.winRate == null ? "—" : Math.round(x.winRate * 100) + "%"}</b><small>${x.closed} closed</small></div>
        <div><small>Best trade</small>${tr(x.best)}</div>
        <div><small>Worst trade</small>${tr(x.worst)}</div>
      </div>
      <h3 class="sec">Positions (${Object.keys(b.pf.pos).length})</h3>
      <div class="list">${pos || `<div class="empty sm">No open positions.</div>`}</div>
      <h3 class="sec">History (${b.pf.trades.length})</h3>
      <div class="list">${hist || `<div class="empty sm">No trades yet. It trades only while the app is open.</div>`}</div>
    </div>`;
}

function openBot(id) {
  if (!BOTS.some(b => b.id === id)) return;
  const wasOpen = !!ui.sheet;
  if (chart?.key?.startsWith("crypto:")) crypto.watchChart(null);
  chart = null; chartToken = null;
  ui.sheet = { kind: "bot", id };
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  $("#scrim").hidden = false; $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
}

function botsSettingsHTML() {
  const full = BOTS.length >= MAX_BOTS;
  return `<h3>Rival bots</h3>
      <p class="mut">Each bot gets its own portfolio, as big as yours (${$usd0(S.start)}), and decides by itself what to buy, how much and when to sell, with your same costs and market hours. Bots trade only while the app is open: nothing is made up for the time it was closed.</p>
      ${BOTS.map(b => { const x = standing(b.pf, quoteFor); return `<div class="bot-row"><span class="nm"><b>${esc(b.name)}</b><small>${STYLES[b.style].name} · ${$usd(x.total)} · <span class="${dirCls(x.pl)}">${$pct(x.plPct * 100)}</span></small></span><button class="btn ghost sm" data-delbot="${esc(b.id)}">Remove</button></div>`; }).join("")}
      <label class="tog"><input type="checkbox" id="botCheatsTog" ${CFG.botCheats ? "checked" : ""}><span>Bots can cheat</span></label>
      <small class="mut">Each bot arms cheats whenever they suit it, with no daily limit (Money printer: once a day): ${BOT_CHEATS.map(c => c.name).join(", ")}. Never Undo, Ghost trade, Oracle, X-ray, Time machine, Skip ahead or Always on. A bot that cheats gets a ★ on the leaderboard, and its cheats show in Rival moves.</small>
      <p class="lbl">Add a bot${full ? ` (max ${MAX_BOTS})` : ""}</p>
      <div class="bot-add">${STYLE_IDS.map(id => `<button class="bot-style" data-addbot="${id}" ${full ? "disabled" : ""}><b>+ ${STYLES[id].name}</b><small>${esc(STYLES[id].desc)}</small></button>`).join("")}</div>`;
}
function renderBotsBox() { const el = $("#botsBox"); if (el) el.innerHTML = botsSettingsHTML(); }

function clockTick() {
  const now = appNow();
  const tot = E.totals(S, quoteFor);
  E.recordDay(S, localDay(now), tot.total, now);
  const got = evaluate(A, [], { trades: S.trades, total: tot.total, start: S.start, now, stockOpenSince: null, cheated: E.isCheated(S) });
  for (const id of got) { const a = achievementById(id); toast(`${a.icon} Achievement: ${a.name}${A.cheated?.[id] ? " ★ (with cheats)" : ""}`, "gold"); }
  if (got.length) saveAch();
  dailySummary(now);
  saveSoon(1000);
}

// Market open/close transitions: re-check waiting orders the moment the bell rings.
let wasOpen = {};
function secondTick() {
  const now = appNow();
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
  if (ui.tab === "home") { updateLastChance(now); updateMovers(now); }
  const sb = C.settleBoost(S, now);
  if (sb) {
    toast(sb.extra > 0 ? `🌙 Moon boost paid ${$usd(sb.extra, { sign: true })} on ${esc(sb.sym)}` : `🌙 Moon boost on ${esc(sb.sym || "your coin")} ended with no gain to triple`, sb.extra > 0 ? "gold" : "");
    saveSoon(0); renderView(); if (ui.sheet?.kind === "cheats") renderSheet(); frame();
  }
  renderTape();
}

// ---------------------------------------------------------------- formatting helpers
function fmtPx(inst, px, full = false) {
  if (!inst) return price(px, null, { full });
  if (inst.m === "fx") return price(px, inst.dp ?? FX_BY_ID[inst.id]?.dp ?? 5, { full });
  return price(px, null, { full });
}
/** Whole dollars when there are no cents: $100,000 instead of $100,000.00. */
const usd0 = (n, full = false) => usd(n, { full }).replace(/\.00$/, "");
// The same, as HTML: an abbreviated number shows the full one when tapped.
const $usd = (n, o = {}) => tap(usd(n, o), usd(n, { ...o, full: true }));
const $usd0 = n => tap(usd0(n), usd0(n, true));
const $pct = (n, d = 2) => tap(pct(n, d), pct(n, d, { full: true }));
const $px = (inst, px) => tap(fmtPx(inst, px), fmtPx(inst, px, true));
const $qty = n => tap(qty(n), qty(n, { full: true }));
/** Set an element's number: abbreviated text, full number on tap. */
function setNum(el, short, full) {
  el.textContent = short;
  if (short !== full) { el.dataset.full = full; el.classList.add("ab"); } else { delete el.dataset.full; el.classList.remove("ab"); }
}
/** Short chip label: $100, $2.5K, $1M. */
function chipLabel(n) {
  if (n >= 1e6) return "$" + +(n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + +(n / 1e3).toFixed(2) + "K";
  return "$" + +n.toFixed(2);
}
function amountChips(start) {
  return CHIP_FRACS.map(f => { const v = start * f; return v >= 10 ? +v.toPrecision(2) : Math.round(v * 100) / 100; }).filter(v => v > 0);
}
function icon(inst) {
  if (inst.img) return `<img class="ico" src="${esc(inst.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  const t = inst.m === "fx" ? inst.base : (inst.sym || "?").slice(0, 4);
  return `<span class="ico ico-${inst.m}" aria-hidden="true">${esc(t)}</span>`;
}
const offline = () => !SIM && navigator.onLine === false;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function chHTML(key) {
  const L = live.get(key);
  if (offline()) return `<small class="flat">offline</small>`;
  const v = L?.ch24;
  return `<small data-c="${esc(key)}" class="${dirCls(v)}">${$pct(v)}</small>`;
}
function subFor(inst) {
  const L = live.get(inst.key) || {};
  if (inst.m === "meme") return `MC ${$usd(L.mc, { compact: true })} · Liq ${$usd(L.liq, { compact: true })}${inst.born ? ` · <span data-age="${inst.born}">${ago(inst.born, appNow())}</span>` : ""}`;
  if (inst.m === "crypto") return esc(inst.name) + (L.vol ? ` · Vol ${$usd(L.vol, { compact: true })}` : "");
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
  const now = appNow();
  const t = E.totals(S, quoteFor);
  const el = $("#total");
  if (SIM && lastTotal != null && Math.abs(t.total - lastTotal) > 0.004) rollNumber(el, lastTotal, t.total, n => usd(n));
  else if (!el._roll || !el.classList.contains("rolling")) el.textContent = usd(t.total);
  el.dataset.full = usd(t.total, { full: true }); el.classList.add("ab");
  if ((S.capCut || 0) > capSeen) { if (capSeen >= 0) worldsRichest(S.capCut - capSeen); capSeen = S.capCut; }
  if (lastTotal != null && Math.abs(t.total - lastTotal) > 0.004) flash(el, t.total > lastTotal ? 1 : -1);
  lastTotal = t.total;
  const day = S.days[localDay(now)];
  const dd = day ? t.total - day.first : null;
  const tp = $("#totalPl");
  tp.innerHTML = `<span class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })} (${$pct(t.plPct * 100)})</span> from ${$usd0(S.start)}` +
    (dd != null && Math.abs(dd) >= 0.01 ? ` · <span class="${dirCls(dd)}">${$usd(dd, { sign: true })} today</span>` : "") +
    (E.isCheated(S) ? ` <span class="star" title="Cheats used in this portfolio">★</span>` : "") +
    (t.capped ? ` <span class="rich-tag">🌍 World's richest</span>` : "");
  const ok = Object.values(src).some(s => s.ok && now - s.ok < 90e3);
  const dot = $("#liveDot"), simb = $("#simBtn");
  if (SIM) {
    dot.className = "live idle"; dot.textContent = "Live"; dot.setAttribute("aria-pressed", "false"); simb?.setAttribute("aria-pressed", "true");
  } else {
    dot.className = "live " + (offline() ? "off" : ok ? "on" : "wait");
    dot.textContent = offline() ? "Offline" : ok ? "Live" : "Connecting";
    dot.setAttribute("aria-pressed", "true"); simb?.setAttribute("aria-pressed", "false");
  }
  updateCombo();
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
      const full = fmtPx(L.inst, L.px, true), txt = el.classList.contains("big") ? full : fmtPx(L.inst, L.px);
      if (el.textContent !== txt) { setNum(el, txt, full); flash(el, L.dir); }
    }
    for (const el of document.querySelectorAll(`[data-c="${sel}"]`)) { el.className = dirCls(L.ch24); setNum(el, pct(L.ch24), pct(L.ch24, 2, { full: true })); }
    for (const m of E.marginPositions(S).filter(x => x.key === k)) {
      const v = E.positionView(m, quoteFor(k), S);
      for (const el of document.querySelectorAll(`[data-mv="${CSS.escape(m.id)}"]`)) setNum(el, usd(v.value), usd(v.value, { full: true }));
      for (const el of document.querySelectorAll(`[data-mpl="${CSS.escape(m.id)}"]`)) { el.className = dirCls(v.pl); setNum(el, `${usd(v.pl, { sign: true })} (${pct(v.plPct * 100, 1)})`, `${usd(v.pl, { sign: true, full: true })} (${pct(v.plPct * 100, 1, { full: true })})`); }
    }
    const p = S.pos[k];
    if (p) {
      const v = E.positionView(p, quoteFor(k), S);
      for (const el of document.querySelectorAll(`[data-v="${sel}"]`)) setNum(el, usd(v.value), usd(v.value, { full: true }));
      for (const el of document.querySelectorAll(`[data-pl="${sel}"]`)) { el.className = dirCls(v.pl); setNum(el, `${usd(v.pl, { sign: true })} (${pct(v.plPct * 100, 1)})`, `${usd(v.pl, { sign: true, full: true })} (${pct(v.plPct * 100, 1, { full: true })})`); }
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
  if (!movers.length) { el.innerHTML = `<span class="tk mut">Waiting for live prices…</span>`; el.style.animationDuration = "0s"; return; }
  const one = movers.map(L => `<button class="tk" data-open="${esc(L.inst.key)}"><b>${esc(L.inst.sym)}</b> <span data-c="${esc(L.inst.key)}" class="${dirCls(L.ch24)}">${$pct(L.ch24, 1)}</span></button>`).join("");
  el.innerHTML = `<div class="tape-run">${one}</div><div class="tape-run" aria-hidden="true">${one}</div>`;
  el.style.animationDuration = Math.max(20, movers.length * 3.2) + "s";
}

const SRC_NAME = { dexscreener: "DexScreener", geckoterminal: "GeckoTerminal", binance: "Binance", coinbase: "Coinbase", coingecko: "CoinGecko", finnhub: "Finnhub", twelvedata: "Twelve Data", "coinbase-fx": "Coinbase (forex)" };
function renderBanners() {
  const out = [];
  const now = appNow();
  if (SIM) {
    out.push(...saveBanners());
    $("#banners").innerHTML = simEventHTML() + out.map(([k, h]) => `<div class="banner ${k}" role="status">${h}</div>`).join("");
    return;
  }
  if (offline()) out.push(["warn", "Offline: you're seeing your portfolio and history with the last saved prices. Orders are checked as soon as the connection is back."]);
  out.push(...saveBanners());
  const f = src.finnhub?.err;
  if (CFG.finnhubKey && f && !offline()) {
    if (f.kind === "auth") out.push(["err", `Finnhub rejected your key. Check it in <button class="lnk" data-settings>Settings</button>. Stocks are using the last saved price.`]);
    else if (f.kind === "limit" && now - src.finnhub.errAt < 120e3) out.push(["warn", "Finnhub hit its per-minute request limit. Stock prices resume as soon as it frees up (under a minute)."]);
  }
  if (needFinnhub() && Object.values(S.pos).some(p => p.inst.m === "stock")) {
    out.push(["warn", `You hold stocks but your Finnhub key is missing: they're valued at the last saved price. <button class="lnk" data-settings>Add key</button>`]);
  }
  const t = src.twelvedata?.err;
  if (CFG.twelveKey && t && !offline()) {
    if (t.kind === "auth") out.push(["err", `Twelve Data rejected your key. Check it in <button class="lnk" data-settings>Settings</button>. Meanwhile, charts use live prices.`]);
    else if (t.kind === "limit" && t.body === "day") out.push(["warn", "Today's Twelve Data candles are used up (800 a day). Stock and forex charts use live prices until tomorrow."]);
  }
  if (!offline()) {
    for (const name of ["dexscreener", "binance", "coinbase", "coinbase-fx"]) {
      const s = src[name];
      if (s?.err && now - s.errAt < 180e3 && (!s.ok || s.ok < s.errAt)) out.push(["warn", `No prices coming from ${SRC_NAME[name]} (${esc(s.err.message.toLowerCase())}). Retrying…`]);
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
  if (ui.tab === "home") v.innerHTML = viewHome();
  else if (ui.tab === "markets") v.innerHTML = viewMarkets();
  else if (ui.tab === "portfolio") v.innerHTML = viewPortfolio();
  else if (ui.tab === "history") v.innerHTML = viewHistory();
  else if (ui.tab === "achievements") v.innerHTML = viewAchievements();
  if (focused) { const el = document.getElementById(focused); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
  window.scrollTo(0, scroll);
  for (const b of $$("nav.tabs button")) b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false");
  renderTape();
}

function marketCards(now) {
  if (SIM) return `<div class="cd-strip sim"><span class="dot"></span>Sim: invented memecoins, crypto, stocks and currencies. Open 24/7, prices move every second.</div>`;
  const st = mstatus("stock", now), fs = mstatus("fx", now);
  const reason = { pre: "Before the open", post: "Closed for the day", weekend: "Weekend", holiday: "Holiday" + (st.holiday ? ": " + st.holiday : "") };
  const ws = st.open
    ? `<div class="cd-card open"><small>Wall Street open${st.early ? " · early close" : ""}</small><span>Closes in</span><b data-cd="${st.closesAt}">${countdown(st.closesAt - now)}</b></div>`
    : `<div class="cd-card"><small>${esc(reason[st.reason] || "Closed")}</small><span>Wall Street opens in</span><b data-cd="${st.nextOpen}">${countdown(st.nextOpen - now)}</b><small>${esc(weekdayTime(st.nextOpen))} your time</small></div>`;
  const fxc = fs.open
    ? `<div class="cd-card open"><small>Forex open</small><span>Closes Friday in</span><b data-cd="${fs.closesAt}">${countdown(fs.closesAt - now)}</b></div>`
    : `<div class="cd-card"><small>Forex closed</small><span>Opens Sunday in</span><b data-cd="${fs.nextOpen}">${countdown(fs.nextOpen - now)}</b></div>`;
  return `<div class="cd-row">${ws}${fxc}</div><div class="cd-strip"><span class="dot"></span>Crypto and memecoins: open 24/7</div>`;
}

function lastChances(now) {
  const out = [];
  if (SIM) return out;
  const st = mstatus("stock", now), fs = mstatus("fx", now);
  const ord = m => S.orders.filter(o => o.inst.m === m).length;
  const pos = m => Object.values(S.pos).filter(p => p.inst.m === m).length;
  if (st.open && st.closesAt - now <= 15 * 60e3 && (ord("stock") || pos("stock"))) {
    out.push({ title: "Wall Street closes in", cd: st.closesAt, text: `${plural(ord("stock"), "open order", "open orders")} · ${plural(pos("stock"), "stock position", "stock positions")}` });
  }
  if (fs.open && fs.closesAt - now <= 60 * 60e3 && (ord("fx") || pos("fx"))) {
    out.push({ title: "Forex closes for the weekend in", cd: fs.closesAt, text: `${plural(ord("fx"), "open order", "open orders")} · ${plural(pos("fx"), "forex position", "forex positions")}` });
  }
  for (const o of S.orders) {
    if (o.type !== "limit") continue;
    const q = quoteFor(o.key);
    if (!q || !mstatus(o.inst.m, now).open) continue;
    const dist = Math.abs(q.px - o.limit) / o.limit;
    if (dist <= 0.005) out.push({ title: `Your ${o.inst.sym} limit order is ${(dist * 100).toFixed(2)}% from filling`, text: `Price ${$px(o.inst, q.px)} · limit ${$px(o.inst, o.limit)}`, key: o.key });
  }
  const seen = new Set();
  for (const k of [...lists.meme.new, ...lists.meme.trending]) {
    const L = live.get(k);
    if (seen.has(k) || !L?.inst.born || now - L.inst.born > 15 * 60e3 || now < L.inst.born) continue;
    seen.add(k);
    out.push({ title: `${L.inst.sym} is new`, text: `Born <span data-age="${L.inst.born}">${ago(L.inst.born, now)}</span> ago · liquidity ${$usd(L.liq, { compact: true })}`, key: k });
    if (seen.size >= 3) break;
  }
  return out;
}
function lastChanceHTML(now) {
  const lc = lastChances(now);
  if (!lc.length) return "";
  return `<section class="lc"><h2>Last chance</h2>${lc.map(x => `
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

function viewHome() {
  const now = appNow();
  lcSig = lastChances(now).map(x => x.title).join("|");
  const streak = greenStreak(S.trades, now);
  const unlocked = Object.keys(A.unlocked).length;
  const todayTrades = S.trades.filter(t => localDay(t.t) === localDay(now)).length;
  const welcome = !S.trades.length ? (SIM
    ? `<div class="hello"><b>Sim mode: ${$usd0(S.start)} in Sim money.</b> Invented markets, prices that move every second, pumps, rugs and wild events. Your Live portfolio is kept apart.</div>`
    : `<div class="hello"><b>You have ${$usd0(S.start)} in fake money.</b> Prices are real and live. Pick a market, buy in two taps and slide to confirm.</div>`) : "";
  const orders = S.orders.length ? `<section><h2>Waiting orders (${S.orders.length})</h2><div class="list">${S.orders.map(orderRow).join("")}</div></section>` : "";
  moversSig = moversSignature(); moversAt = now;
  return `${welcome}${marketCards(now)}<div id="lcSlot">${lastChanceHTML(now)}</div>
    <div class="stat-row">
      <div><small>Green streak</small><b>${streak ? "🔥 " + plural(streak, "day", "days") : "—"}</b></div>
      <div><small>Trades today</small><b>${todayTrades}</b></div>
      <div><small>Achievements</small><b>${unlocked}/${ACHIEVEMENTS.length}</b></div>
    </div>
    ${orders}
    ${rivalsHome()}
    <h2>Top movers (24h)</h2><div id="moversSlot">${moversHTML()}</div>`;
}

// The movers block refreshes itself when the instruments in it change (not on every tick).
let moversSig = "", moversAt = 0;
function moversSignature() { return MARKETS.map(m => moversFor(m).map(i => i.key).sort().join(",")).join("|"); }
function moversHTML() {
  return MARKETS.map(m => {
    if (m === "stock" && needFinnhub()) return `<section class="mv"><h3>${MARKET_LABEL[m]}</h3>${noKeyCard()}</section>`;
    if (m === "stock" && src.finnhub?.err?.kind === "auth") return `<section class="mv"><h3>${MARKET_LABEL[m]}</h3>${badKeyCard()}</section>`;
    const list = moversFor(m);
    return `<section class="mv"><h3>${MARKET_LABEL[m]} <button class="lnk" data-market="${m}">see all</button></h3>
      <div class="list">${list.length ? list.map(rowHTML).join("") : `<div class="empty sm">Loading live prices…</div>`}</div></section>`;
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
  return `<div class="nokey bad"><b>Finnhub rejected your key</b>
    <p>Make sure you copied all of it from your <a href="https://finnhub.io/dashboard" target="_blank" rel="noopener">finnhub.io</a> dashboard and paste it again in Settings.</p>
    <button class="btn" data-settings>Go to Settings</button></div>`;
}
function noKeyCard() {
  return `<div class="nokey"><b>Add your Finnhub key in Settings</b>
    <p>Stocks need a free Finnhub key. Create one at <a href="${FINNHUB_SIGNUP}" target="_blank" rel="noopener">finnhub.io/register</a> and paste it in Settings; it's saved only on this phone.</p>
    <button class="btn" data-settings>Go to Settings</button></div>`;
}

function viewMarkets() {
  const m = ui.market;
  const seg = MARKETS.map(x => `<button data-market="${x}" aria-pressed="${x === m}">${MARKET_LABEL[x]}</button>`).join("");
  const ph = SIM ? { meme: "Name or symbol: Frog, Moon…", crypto: "Symbol or name: NBL, Nebulon…", stock: "Symbol or name: ZTRX, Nova…", fx: "Currency: ZVK, LUD, NMF…" }[m]
    : { meme: "Name, symbol or Solana address", crypto: "Symbol: BTC, PEPE…", stock: "Symbol or name: AAPL, Nvidia…", fx: "Pair: EUR, MXN, JPY…" }[m];
  let body;
  if (m === "stock" && needFinnhub()) body = noKeyCard();
  else if (m === "stock" && src.finnhub?.err?.kind === "auth") body = badKeyCard();
  else {
    const res = lists.search[m];
    let keys, head = "";
    if (res) {
      keys = res;
      head = `<div class="res-head">Results for “${esc(ui.query[m])}” <button class="lnk" data-clear>Clear search</button></div>`;
    } else if (m === "meme") keys = lists.meme[ui.memeView];
    else keys = lists[m];
    const sub = m === "meme" && !res ? `<div class="seg sub">${["trending", "new"].map(v => `<button data-memeview="${v}" aria-pressed="${ui.memeView === v}">${v === "trending" ? "Trending" : "New"}</button>`).join("")}</div>` : "";
    const rows = keys.map(k => live.get(k)?.inst || instOf(k)).filter(Boolean).map(rowHTML).join("");
    body = sub + head + `<div class="list">${rows || `<div class="empty">${ui.searching ? "Searching…" : res ? "No results." : "Loading live prices…"}</div>`}</div>`;
  }
  const foot = {
    meme: `Prices from DexScreener (Solana) every 10 s, candles from GeckoTerminal. 1% fee + price impact based on liquidity.`,
    crypto: `The 30 largest by market cap (CoinGecko, no stablecoins). Live prices from ${crypto.mode === "coinbase" ? "Coinbase" : "Binance"}. 0.1% fee + 0.02% slippage.`,
    stock: `Real-time prices from Finnhub. $0 commission; you pay half the spread (the greater of $0.01 or 0.01%). Trades only 9:30 AM to 4:00 PM New York time.`,
    fx: `Coinbase mid rate (updates every 30–60 s). $0 commission; you pay each pair's typical spread. Open Sunday 5:00 PM to Friday 5:00 PM New York time.`,
  }[m];
  const simFoot = { meme: "Sim memecoins: a new one every few seconds. Most bleed, some pump +1,000% in minutes, a rare few go 100x, many rug. Same 1% fee + price impact as Live.", crypto: "Sim crypto: invented coins, high volatility, liquidation cascades when too many are leveraged. Same costs as Live.", stock: "Sim stocks: invented companies with crashes and rallies, open 24/7. Same costs as Live.", fx: "Sim forex: invented currencies, calm except on news. Same spreads as Live." }[m];
  return `<div class="seg mk">${seg}</div>
    <form class="search" data-search><input id="q-${m}" type="search" enterkeyhint="search" autocomplete="off" placeholder="${ph}" value="${esc(ui.query[m])}" aria-label="Search ${MARKET_LABEL[m]}"><button class="btn">Search</button></form>
    ${body}<p class="foot">${SIM ? simFoot : foot}</p>`;
}

function orderRow(o) {
  const what = o.side === "buy" ? `Buy ${$usd(o.amount)}` : `Sell ${Math.round(o.frac * 100)}%`;
  const how = o.type === "limit" ? `if it hits ${$px(o.inst, o.limit)}` : `at the market open`;
  return `<div class="ord"><button class="ord-main" data-open="${esc(o.key)}">${icon(o.inst)}<span class="nm"><b>${esc(o.inst.sym)}</b><small>${what} ${how}</small></span></button>
    <button class="x" data-cancel="${o.id}" aria-label="Cancel order">Cancel</button></div>`;
}

function viewPortfolio() {
  const t = E.totals(S, quoteFor);
  const pos = Object.values(S.pos).sort((a, b) => b.cost - a.cost);
  const mpos = E.marginPositions(S);
  const rows = pos.map(p => {
    const v = E.positionView(p, quoteFor(p.key), S);
    const bo = S.cheats?.boost?.key === p.key ? S.cheats.boost : null;
    const badges = [p.sl ? `SL ${$px(p.inst, p.sl)}` : "", p.tp ? `TP ${$px(p.inst, p.tp)}` : "", p.cost === 0 ? "free (airdrop)" : "", p.ghost ? "👻" : "",
      bo ? `🌙 3x <span data-cd="${bo.until}">${countdown(bo.until - appNow())}</span>` : ""].filter(Boolean).join(" · ");
    return `<button class="row" data-open="${esc(p.key)}">${icon(p.inst)}
      <span class="nm"><b>${esc(p.inst.sym)} <i class="mk-tag">${MARKET_LABEL[p.inst.m]}</i></b><small>Invested ${$usd(p.cost)}${badges ? " · " + badges : ""}${v.live ? "" : " · last saved price"}</small></span>
      <span class="px"><b data-v="${esc(p.key)}">${$usd(v.value)}</b><small data-pl="${esc(p.key)}" class="${dirCls(v.pl)}">${$usd(v.pl, { sign: true })} (${$pct(v.plPct * 100, 1)})</small></span></button>`;
  }).join("");
  return `<div class="stat-row">
      <div><small>Cash</small><b>${$usd(t.cash)}</b></div>
      <div><small>Available</small><b>${$usd(t.cash - t.reserved)}</b></div>
      <div><small>Invested</small><b>${$usd(t.held)}</b></div>
    </div>
    <h2>Positions (${pos.length})</h2>
    <div class="list">${rows || `<div class="empty">No open positions. Go to Markets, open something and buy.</div>`}</div>
    ${mpos.length ? `<h2>Leveraged and short (${mpos.length})</h2><div class="list">${mpos.map(marginRow).join("")}</div>` : ""}
    <h2>Waiting orders (${S.orders.length})</h2>
    <div class="list">${S.orders.map(orderRow).join("") || `<div class="empty sm">No limit orders or orders waiting for the open.</div>`}</div>
    <p class="foot">To move this portfolio to another device, use Export and Import in <button class="lnk" data-settings>Settings</button>.</p>`;
}

function marginRow(p) {
  const q = quoteFor(p.key), v = E.positionView(p, q, S), liq = E.liqPrice(p, q);
  const safe = C.isOn(S, "diamond") ? "💎 no liquidation" : C.isOn(S, "rugShield") ? "🛡️ shielded" : liq > 0 ? `liq. ${$px(p.inst, liq)}` : "";
  return `<button class="row" data-open="${esc(p.key)}">${icon(p.inst)}
      <span class="nm"><b>${esc(p.inst.sym)} <i class="mk-tag lev">${p.lev}x ${p.dir > 0 ? "Long" : "Short"}</i></b><small>Margin ${$usd(p.cost)}${safe ? " · " + safe : ""}${p.ghost ? " · 👻" : ""}${v.live ? "" : " · last saved price"}</small></span>
      <span class="px"><b data-mv="${esc(p.id)}">${$usd(v.value)}</b><small data-mpl="${esc(p.id)}" class="${dirCls(v.pl)}">${$usd(v.pl, { sign: true })} (${$pct(v.plPct * 100, 1)})</small></span></button>`;
}

const REASON = { manual: "", limit: "limit order", open: "at the open", sl: "stop loss", tp: "take profit", bot: "", liq: "liquidated", airdrop: "airdrop", replay: "", trail: "trailing stop" };
function tradeItem(t) {
  const why = t.why ? esc(t.why) : REASON[t.reason] || "";
  const lbl = sideLabel(t);
  const right = t.reason === "airdrop" ? `<b>Free</b><small class="flat">worth ${$usd(t.worth || 0)}</small>`
    : `<b>${$usd(t.usd)}</b>${t.side === "sell" ? `<small class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })} (${$pct(t.plPct * 100, 1)})</small>` : `<small class="flat">costs ${$usd((t.fee || 0) + (t.slip || 0))}</small>`}`;
  return `<div class="tr${t.cheat?.length ? " cheat" : ""}">
      <span class="side ${t.side}${t.dir === -1 ? " short" : ""}">${lbl}</span>
      <span class="nm"><b>${esc(t.sym)}${t.lev > 1 ? ` <i class="mk-tag lev">${t.lev}x</i>` : ""}</b><small>${$qty(t.qty)} at ${$px(instOf(t.key) || { m: t.m, id: t.key.split(":")[1] }, t.reason === "airdrop" ? t.mid : t.px)}</small><small>${dateTime(t.t)}${why ? " · " + why : ""}</small>${t.cheat?.length ? `<small class="cheat-tag">★ ${esc(t.cheat.join(", "))}</small>` : ""}</span>
      <span class="px">${right}</span>
    </div>`;
}

/** The star on a portfolio's history: what was used and since when. */
function cheatNoteHTML(pf) {
  if (!E.isCheated(pf)) return "";
  const log = pf.cheats.log.slice().reverse().slice(0, 60);
  return `<div class="cheat-note"><b><span class="star">★</span> Cheats used in this portfolio</b><small>Since ${dateTime(pf.cheats.since)}. Resetting the portfolio removes the star.</small>
    <details><summary>What was used (${pf.cheats.log.length})</summary>${log.map(l => `<div class="cl"><small>${dateTime(l.t)}</small> ${esc(l.text)}</div>`).join("")}</details></div>`;
}
function viewHistory() {
  const f = ui.hist;
  const trades = S.trades.filter(t => f === "all" || t.m === f).slice().reverse();
  const sb = scoreboard(S.trades.filter(t => f === "all" || t.m === f)).all;
  const chips = ["all", ...MARKETS].map(m => `<button data-hist="${m}" aria-pressed="${f === m}">${m === "all" ? "All" : MARKET_LABEL[m]}</button>`).join("");
  const items = trades.slice(0, ui.histN).map(tradeItem).join("");
  return `${cheatNoteHTML(S)}<div class="seg chips">${chips}</div>
    <div class="stat-row">
      <div><small>Trades</small><b>${trades.length}</b></div>
      <div><small>Win rate</small><b>${sb.winRate == null ? "—" : Math.round(sb.winRate * 100) + "%"}</b></div>
      <div><small>Realized P&amp;L</small><b class="${dirCls(sb.total)}">${$usd(sb.total, { sign: true })}</b></div>
    </div>
    <div class="list">${items || `<div class="empty">Every buy and sell is saved here.</div>`}</div>
    ${trades.length > ui.histN ? `<button class="btn ghost wide" data-more>Show more</button>` : ""}
    <button class="btn wide" data-csv ${trades.length ? "" : "disabled"}>Export to CSV${f === "all" ? "" : " (" + MARKET_LABEL[f] + ")"}</button>`;
}

function viewAchievements() {
  const now = appNow();
  const streak = greenStreak(S.trades, now);
  const sb = scoreboard(S.trades);
  const tr = t => t ? `<b class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })}</b><small>${esc(t.sym)} · ${$pct(t.plPct * 100, 1)}</small>` : "<b>—</b>";
  const card = (label, b) => `<div class="sb">
      <h3>${label}</h3>
      <div class="sb-grid">
        <div><small>Total P&amp;L</small><b class="${dirCls(b.total)}">${$usd(b.total, { sign: true })}</b></div>
        <div><small>Win rate</small><b>${b.winRate == null ? "—" : Math.round(b.winRate * 100) + "%"}</b><small>${b.n} closed</small></div>
        <div><small>Best</small>${tr(b.best)}</div>
        <div><small>Worst</small>${tr(b.worst)}</div>
      </div></div>`;
  const cheated = id => A.unlocked[id] && A.cheated?.[id];
  const grid = ACHIEVEMENTS.map(a => {
    const got = A.unlocked[a.id] && !cheated(a.id);
    return `<div class="ach ${got ? "got" : ""}"><span class="ach-i" aria-hidden="true">${a.icon}</span><b>${esc(a.name)}</b><small>${got ? "Unlocked " + dateTime(A.unlocked[a.id]) : esc(a.desc)}</small></div>`;
  }).join("");
  const withCheats = ACHIEVEMENTS.filter(a => cheated(a.id));
  const cheatGrid = withCheats.map(a => `<div class="ach got cheat"><span class="ach-i" aria-hidden="true">${a.icon}</span><b>${esc(a.name)} <span class="star">★</span></b><small>With cheats · ${dateTime(A.unlocked[a.id])}</small></div>`).join("");
  const rivals = `<h2>Leaderboard</h2>${BOTS.length ? `<div id="lbSlotFull">${leaderboardHTML()}</div>` : `<div class="empty sm">No rivals yet. <button class="lnk" data-settings>Add a bot in Settings</button> to race against it: Momentum, Contrarian, Degen or Random.</div>`}`;
  return `${SIM ? recordsHTML() : ""}${ladderHTML()}${rivals}<div class="streak"><span>🔥</span><div><b>${plural(streak, "green day", "green days")}</b><small>Days in a row closing trades with a net profit.</small></div></div>
    <h2>Scoreboards</h2>
    <div class="seg chips">${["all", ...MARKETS].map(m => `<button data-sb="${m}" aria-pressed="${ui.sb === m}">${m === "all" ? "All" : MARKET_LABEL[m]}</button>`).join("")}</div>
    ${card(ui.sb === "all" ? "All markets" : MARKET_LABEL[ui.sb], sb[ui.sb])}
    <h2>Achievements (${Object.keys(A.unlocked).length - withCheats.length}/${ACHIEVEMENTS.length})</h2>
    <p class="foot">Achievements are kept separately: they stay even if you reset your portfolio. Money goals are measured against your starting balance.</p>
    <div class="ach-grid">${grid}</div>
    ${withCheats.length ? `<h2><span class="star">★</span> Earned with cheats (${withCheats.length})</h2>
    <p class="foot">Unlocked while your portfolio was using cheats, so they're kept apart. Earn one again without cheats to move it up.</p>
    <div class="ach-grid">${cheatGrid}</div>` : ""}`;
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
  if (TEST || SIM) return;
  if (inst.m === "stock" && fh.hasKey()) { fh.watch([inst.id]); stockQuote(inst.id).catch(noteError); }
  if (inst.m === "crypto") crypto.watch([inst.id]).catch(noteError);
  if (inst.m === "meme") kick("meme");
}
/** Open a full sheet that isn't an instrument (settings, cheats, Time machine). */
function openPanel(sheet) {
  const wasOpen = !!ui.sheet;
  if (ui.sheet?.kind === "replay" && sheet.kind !== "replay") stopReplayTimer();
  if (chart?.key?.startsWith("crypto:")) crypto.watchChart(null);
  chart = null; chartToken = null;
  ui.sheet = sheet;
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  $("#scrim").hidden = false; $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
}
function openSettings() {
  const wasOpen = !!ui.sheet;
  ui.sheet = { kind: "settings" };
  ui.resetStart = S.start; ui.resetCustom = !START_CHOICES.includes(S.start);
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  $("#scrim").hidden = false; $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
}
function closeSheet(fromPop) {
  if (!ui.sheet) return;
  stopReplayTimer();
  if (chart && (chart.src === "twelvedata" || chart.src === "cache")) td.saveLive(chart.sym, chart.ivl, chart.bars).catch(() => {});
  if (chart?.key?.startsWith("crypto:")) crypto.watchChart(null);
  chart = null; chartToken = null;
  ui.sheet = null;
  $("#scrim").hidden = true; $("#sheet").hidden = true; $("#sheet").innerHTML = "";
  document.body.classList.remove("noscroll");
  if (!fromPop && history.state?.sheet) history.back();
}

function marketLine(inst, now = appNow()) {
  if (SIM) return `<span class="mkt open">Sim · always open</span>`;
  if (inst.m === "meme" || inst.m === "crypto") return `<span class="mkt open">Open 24/7</span>`;
  const st = mstatus(inst.m, now);
  const name = inst.m === "stock" ? "Wall Street" : "Forex";
  if (st.open) return `<span class="mkt open">${name} open · closes in <b data-cd="${st.closesAt}">${countdown(st.closesAt - now)}</b></span>`;
  return `<span class="mkt closed">${name} closed · opens in <b data-cd="${st.nextOpen}">${countdown(st.nextOpen - now)}</b></span>`;
}

function statsFor(inst, L) {
  const s = [];
  if (inst.m === "meme") {
    s.push(["Market cap", usd(L.mc, { compact: true })], ["Liquidity", usd(L.liq, { compact: true })], ["24h volume", usd(L.vol, { compact: true })]);
    if (inst.born) s.push(["Age", `<span data-age="${inst.born}">${ago(inst.born, appNow())}</span>`]);
  } else if (inst.m === "crypto") {
    const m = crypto.meta[inst.id] || {};
    s.push(["24h volume", usd(L.vol, { compact: true })]);
    if (m.mc) s.push(["Market cap", usd(m.mc, { compact: true })]);
    if (m.rank) s.push(["Rank by size", "#" + m.rank]);
    s.push(["Costs", "0.1% + 0.02%"]);
  } else if (inst.m === "stock") {
    s.push(["Open", price(L.o)], ["High", price(L.hi)], ["Low", price(L.lo)], ["Previous close", price(L.prev)]);
  } else {
    const p = FX_BY_ID[inst.id];
    const pip = inst.quote === "JPY" || L.px >= 20 ? 0.01 : 0.0001;
    s.push(["Typical spread", `${((p?.spread ?? L.px * 0.0002) / pip).toFixed(1)} pips`], ["Change vs. yesterday", pct(L.ch24, 3)], ["Source", SIM ? "Sim" : "Coinbase (mid)"]);
  }
  return `<div class="stats">${s.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join("")}</div>`;
}

function changeLine(inst, L) {
  if (offline()) return `<div class="chg flat">offline</div>`;
  if (inst.m === "meme") return `<div class="chg">${[["5m", L.ch5m], ["1h", L.ch1h], ["6h", L.ch6h], ["24h", L.ch24]].map(([k, v]) => `<span class="${dirCls(v)}">${$pct(v, 1)}</span> ${k}`).join(" · ")}</div>`;
  const lbl = inst.m === "fx" ? "vs. yesterday" : inst.m === "stock" ? "today" : "24h";
  return `<div class="chg"><span data-c="${esc(inst.key)}" class="${dirCls(L.ch24)}">${$pct(L.ch24)}</span> ${lbl}</div>`;
}

function renderSheet() {
  const el = $("#sheet");
  if (!ui.sheet) return;
  if (ui.sheet.kind === "settings") { el.innerHTML = settingsHTML(); bindSettings(); return; }
  if (ui.sheet.kind === "cheats") { const y = el.querySelector(".sh-body")?.scrollTop || 0; el.innerHTML = cheatsHTML(); const body = el.querySelector(".sh-body"); if (body) body.scrollTop = y; return; }
  if (ui.sheet.kind === "replay") { if (!ui.replay) { closeSheet(); return; } const y = el.querySelector(".sh-body")?.scrollTop || 0; el.innerHTML = replayHTML(); const body = el.querySelector(".sh-body"); if (body) body.scrollTop = y; drawReplay(); return; }
  if (ui.sheet.kind === "bot") { const b = BOTS.find(x => x.id === ui.sheet.id); if (!b) { closeSheet(); return; } const y = el.querySelector(".sh-body")?.scrollTop || 0; el.innerHTML = botSheetHTML(b); const body = el.querySelector(".sh-body"); if (body) body.scrollTop = y; return; }
  const sh = ui.sheet, key = sh.key, inst = instOf(key), L = live.get(key) || {};
  const p = S.pos[key];
  const needKey = inst.m === "stock" && needFinnhub();
  const myOrders = S.orders.filter(o => o.key === key);
  const myAlerts = CFG.alerts.filter(a => a.key === key);
  const posHTML = p ? (() => {
    const v = E.positionView(p, quoteFor(key), S);
    const avg = inst.m === "fx" ? p.avg : p.cost / p.qty;
    return `<section class="card pos">
      <h3>Your position</h3>
      <div class="stats">
        <div><small>Quantity</small><b>${$qty(p.qty)}</b></div>
        <div><small>Worth</small><b data-v="${esc(key)}">${$usd(v.value)}</b></div>
        <div><small>P&amp;L</small><b data-pl="${esc(key)}" class="${dirCls(v.pl)}">${$usd(v.pl, { sign: true })} (${$pct(v.plPct * 100, 1)})</b></div>
        <div><small>Average price</small><b>${$px(inst, avg)}</b></div>
      </div>
      ${p.best > 0 ? `<p class="lc-line">⏳ High since you bought: <b>${$px(inst, p.best)}</b>${L.px > 0 ? ` (now ${$pct(-E.drawdown(p, L.px) * 100, 1)})` : ""}. ${CFG.lc.trail ? "Trailing stop sells" : CFG.lc.warn ? "Last chance warning" : "Last chance is off;"} at ${$px(inst, p.best * (1 - CFG.lc.pct / 100))} (−${CFG.lc.pct}%).</p>` : ""}
      <div class="stops">
        <label>Stop loss <input id="slIn" type="number" inputmode="decimal" step="any" min="0" placeholder="price" value="${p.sl ?? ""}"></label>
        <div class="chips">${[5, 10, 20].map(n => `<button data-sl="${n}">−${n}%</button>`).join("")}</div>
        <label>Take profit <input id="tpIn" type="number" inputmode="decimal" step="any" min="0" placeholder="price" value="${p.tp ?? ""}"></label>
        <div class="chips">${[10, 25, 50].map(n => `<button data-tp="${n}">+${n}%</button>`).join("")}</div>
        <button class="btn" data-savestops>Save stop loss and take profit</button>
        <small class="mut">They sell automatically when the live price hits them${inst.m === "stock" || inst.m === "fx" ? " (while the market is open)" : ""}. The % are from your average price.</small>
      </div></section>`;
  })() : "";
  el.innerHTML = `
    <div class="sh-head">${icon(inst)}<div class="sh-title"><h2>${esc(inst.sym)}</h2><small>${esc(inst.name)} · ${MARKET_LABEL[inst.m]}</small></div>
      <button class="close" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">
      <div class="big" data-p="${esc(key)}">${L.px > 0 ? fmtPx(inst, L.px, true) : "—"}</div>
      ${changeLine(inst, L)}
      ${E.whaleMult(S, key) !== 1 && L.px > 0 ? `<div class="chg">🐋 In your game: <b>${$px(inst, L.px * E.whaleMult(S, key))}</b> (${$pct((E.whaleMult(S, key) - 1) * 100, 2)} from your own trades)</div>` : ""}
      <div class="mline">${marketLine(inst)}</div>
      ${needKey ? noKeyCard() : `
      <div class="chart-bar">
        <div class="seg tiny">${["1m", "5m", "1h", "1d"].map(i => `<button data-ivl="${i}" aria-pressed="${sh.ivl === i}">${i}</button>`).join("")}</div>
        <div class="seg tiny">${[["candles", "Candles"], ["line", "Line"]].map(([k, l]) => `<button data-mode="${k}" aria-pressed="${CFG.chartMode === k}">${l}</button>`).join("")}</div>
      </div>
      <canvas id="chart" aria-label="${esc(inst.sym)} chart"></canvas>
      <div class="chart-note" id="chartNote">${esc(chart?.note || "")}</div>
      ${SIM ? `<div class="oracle-note" id="oracleNote"></div>` : ""}
      <div class="skip${SIM ? "" : " off"}" role="group" aria-label="Skip ahead"><span>⏩ Skip ahead${SIM ? "" : ` <small class="sim-only">Sim only</small>`}</span><div class="skip-row">${Object.keys(SW.SKIPS).map(k => `<button class="btn sm ghost" data-skip="${k}" ${SIM ? "" : "disabled"}>+${k}</button>`).join("")}</div></div>
      <div class="skip${SIM ? "" : " off"}" role="group" aria-label="Rewind"><span>⏪ Rewind ★${SIM ? "" : ` <small class="sim-only">Sim only</small>`}</span><div class="skip-row">${Object.keys(RW.REWINDS).map(k => `<button class="btn sm ghost" data-rewind="${k}" ${SIM ? "" : "disabled"}>−${k}</button>`).join("")}</div></div>
      ${statsFor(inst, L)}`}
      ${posHTML}
      ${marginCardHTML(key)}
      ${myOrders.length ? `<section class="card"><h3>${esc(inst.sym)} orders</h3><div class="list">${myOrders.map(orderRow).join("")}</div></section>` : ""}
      ${needKey ? "" : `<section class="card">
        <h3>Alert me when it hits</h3>
        <form class="alert-form" data-alertform><input id="alertIn" type="number" inputmode="decimal" step="any" min="0" placeholder="price" aria-label="Alert price"><button class="btn">Alert me</button></form>
        ${myAlerts.map(a => `<div class="alert-row">${a.dir === "above" ? "If it rises to" : "If it falls to"} ${$px(inst, a.price)} <button class="lnk" data-delalert="${a.id}">remove</button></div>`).join("")}
      </section>`}
      ${inst.m === "meme" && inst.url ? `<p class="foot"><a href="${esc(inst.url)}" target="_blank" rel="noopener">View on DexScreener ↗</a></p>` : ""}
    </div>
    <div class="sh-foot" id="tradeBox">${needKey ? "" : tradeBoxHTML()}</div>`;
  bindTradeBox();
  drawChartSoon(true);
}

function marginCardHTML(key) {
  const mine = E.marginPositions(S).filter(x => x.key === key);
  if (!mine.length) return "";
  return `<section class="card"><h3>Leveraged and short</h3><div class="list">${mine.map(m => `<div class="ord">${marginRow(m).replace(/^<button class="row" data-open="[^"]*">/, '<div class="row">').replace(/<\/button>$/, "</div>")}<button class="x" data-closem="${esc(m.id)}">Close</button></div>`).join("")}</div>
    <small class="mut">Closing pays back your margin plus or minus the move on the full size, minus the same costs as a normal trade.</small></section>`;
}
const isMarginSide = side => side === "short" || (side === "buy" && C.leverage(S) > 1);

function tradeBoxHTML() {
  const sh = ui.sheet, p = S.pos[sh.key], inst = instOf(sh.key);
  const lev = C.leverage(S), canShort = C.canShort(S, inst);
  if (!sh.side) {
    return `<div class="bs${canShort ? " three" : ""}">
      <button class="big-btn buy" data-side="buy">Buy${lev > 1 ? ` ${lev}x` : ""}</button>
      <button class="big-btn sell" data-side="sell" ${p ? "" : "disabled"}>Sell</button>
      ${canShort ? `<button class="big-btn short" data-side="short">Short${lev > 1 ? ` ${lev}x` : ""}</button>` : ""}</div>`;
  }
  const buy = sh.side !== "sell", margin = isMarginSide(sh.side);
  if (margin) sh.type = "market";
  const avail = E.available(S);
  const chips = buy
    ? amountChips(S.start).map(n => `<button data-amt="${n}" aria-pressed="${sh.amount === n}">${chipLabel(n)}</button>`).join("") + `<button data-amt="max" aria-pressed="${Math.abs(sh.amount - Math.floor(avail * 100) / 100) < 0.005}">Max</button>`
    : [0.25, 0.5, 0.75, 1].map(f => `<button data-frac="${f}" aria-pressed="${sh.frac === f}">${f * 100}%</button>`).join("");
  return `<div class="tb ${sh.side}">
    <div class="tb-top"><button class="lnk" data-back>← Back</button>
      ${margin ? `<span class="mk-tag lev">${lev}x ${sh.side === "short" ? "Short" : "Long"} · market</span>` : `<div class="seg tiny">${[["market", "Market"], ["limit", "Limit"]].map(([k, l]) => `<button data-type="${k}" aria-pressed="${sh.type === k}">${l}</button>`).join("")}</div>`}</div>
    <div class="chips amt">${chips}</div>
    ${buy ? `<label class="amt-in">Amount in dollars <input id="amtIn" type="number" inputmode="decimal" step="any" min="0" value="${sh.amount || ""}"></label>` : ""}
    ${sh.type === "limit" ? `<label class="amt-in">${buy ? "Buy if it falls to" : "Sell if it rises to"} <input id="limIn" type="number" inputmode="decimal" step="any" min="0" value="${sh.limit ?? ""}"></label>` : ""}
    <div class="quote" id="quote" aria-live="polite"></div>
    ${swipeHTML(sh.side === "short" ? "sell" : sh.side, sh.side === "short" ? `Slide to short${lev > 1 ? " " + lev + "x" : ""}` : buy ? `Slide to buy${margin ? " " + lev + "x" : ""}` : "Slide to sell")}
  </div>`;
}

function tradePreview() {
  const sh = ui.sheet, inst = instOf(sh.key), p = S.pos[sh.key];
  const now = appNow();
  const q = quoteFor(sh.key);
  const mkt = mstatus(inst.m, now);
  const lines = [];
  let ok = true;
  const isLimit = sh.type === "limit";
  if (isLimit && !(sh.limit > 0)) { lines.push("Set the limit price."); ok = false; }
  const qx = isLimit && sh.limit > 0 && q ? { ...q, px: sh.limit } : q;
  if (!q) { lines.push(offline() ? "Offline: you can't trade without a live price." : "Waiting for a live price…"); ok = false; }
  const costName = inst.m === "meme" ? "impact" : inst.m === "crypto" ? "slippage" : "spread";
  const mods = { zeroFees: C.isOn(S, "zeroFees"), marketMaker: C.isOn(S, "marketMaker") };
  const gq = qx ? E.gameQuote(S, sh.key, qx) : qx;
  if (isMarginSide(sh.side)) {
    const lev = C.leverage(S), dir = sh.side === "short" ? -1 : 1, avail = E.available(S);
    if (!(sh.amount > 0)) { lines.push("Choose how much margin to put in."); ok = false; }
    else if (sh.amount > avail + 1e-9) { lines.push(`Not enough cash: you have ${$usd(avail)} available.`); ok = false; }
    else if (gq) {
      const r = quoteOpenMargin(inst, sh.amount, lev, dir, gq, mods);
      if (r) {
        const liq = E.liqPrice({ inst, avg: r.eff, dir, cost: sh.amount, entryFee: r.fee, qty: r.qty }, gq);
        lines.push(`${dir > 0 ? "Long" : "Short"} ${$usd(r.notional)} (${lev}x on ${$usd(sh.amount)} of margin) at ${$px(inst, r.eff)} · fee ${$usd(r.fee)} · ${costName} ${$usd(r.slip)}`);
        lines.push(C.isOn(S, "diamond") ? "💎 Diamond hands: it won't be liquidated." : C.isOn(S, "rugShield") ? "🛡️ Rug shield: it can't lose more than 20%." : liq > 0 ? `Liquidated at ${$px(inst, liq)} (${$pct((liq / q.px - 1) * 100, 1)}) if the loss reaches your margin.` : "Liquidated if the loss reaches your margin.");
      }
    }
    if (!mkt.open) { lines.push(`<b>${inst.m === "stock" ? "Wall Street" : "Forex"} is closed:</b> leveraged and short trades need an open market.`); ok = false; }
    lines.push(...armedNotes(sh.side, inst, false));
    return { html: lines.join("<br>"), ok };
  }
  if (sh.side === "buy") {
    const avail = E.available(S);
    if (!(sh.amount > 0)) { lines.push("Choose an amount."); ok = false; }
    else if (sh.amount > avail + 1e-9) { lines.push(`Not enough cash: you have ${$usd(avail)} available.`); ok = false; }
    else if (qx) {
      const r = quoteBuy(inst, sh.amount, gq, mods);
      if (r) lines.push(`You get ~${$qty(r.qty)} ${esc(inst.m === "fx" ? inst.base : inst.sym)} at ${$px(inst, r.eff)} · fee ${$usd(r.fee)} · ${costName} ${$usd(r.slip)}`);
    }
  } else if (p && qx) {
    const r = quoteSell(inst, p, sh.frac, gq, mods);
    if (r) lines.push(`You get ~${$usd(r.proceeds)} · P&amp;L <span class="${dirCls(r.pl)}">${$usd(r.pl, { sign: true })} (${$pct(r.plPct * 100, 1)})</span> · fee ${$usd(r.fee)} · ${costName} ${$usd(r.slip)}`);
  }
  if (isLimit && sh.limit > 0) {
    lines.push(`Fills at the live price when it hits ${$px(inst, sh.limit)}, while the app is open; when you open it, it's checked against the current price.`);
    if (q && (sh.side === "buy" ? q.px <= sh.limit : q.px >= sh.limit)) lines.push("The price is already there: it will fill when you confirm.");
  }
  lines.push(...armedNotes(sh.side, inst, isLimit || !mkt.open));
  if (!mkt.open) {
    lines.push(`<b>${inst.m === "stock" ? "Wall Street" : "Forex"} is closed:</b> the order waits for the open (in <b data-cd="${mkt.nextOpen}">${countdown(mkt.nextOpen - now)}</b>) and fills at the first real price.`);
    if (!q) ok = sh.side === "buy" ? sh.amount > 0 && sh.amount <= E.available(S) : !!p;
  }
  return { html: lines.join("<br>"), ok };
}

/** Cheats armed for the next trade, said in the trade box before you slide. */
function armedNotes(side, inst, waiting) {
  const n = [];
  if (side !== "sell") {
    if (!waiting && inst.m === "meme" && C.isArmed(S, "sniper")) n.push("🔭 Sniper: fills at the price of this coin's first candle.");
    else if (!waiting && C.isArmed(S, "golden")) n.push("🥇 Golden entry: fills at the lowest price of the last 15 minutes.");
    if (C.isArmed(S, "ghost")) n.push("👻 Ghost trade: if this position closes at a loss, it's erased.");
  } else {
    if (!waiting && C.isArmed(S, "perfect")) n.push("🎯 Perfect exit: fills at today's highest price.");
    if (C.isArmed(S, "lucky")) n.push("🍀 2x Lucky trade: a profit on this sale pays double.");
    if (C.isArmed(S, "insurance")) n.push("☂️ Insurance: half of a loss on this sale comes back.");
  }
  if (C.isOn(S, "rugShield") && side === "sell") n.push("🛡️ Rug shield: it can't lose more than 20%.");
  return n.map(x => `<span class="armed">${x}</span>`);
}

function bindTradeBox() {
  const box = $("#tradeBox");
  if (!box || !ui.sheet || ui.sheet.kind !== "inst") return;
  const upd = () => { const r = tradePreview(); const qd = $("#quote"); if (qd) qd.innerHTML = r.html; setSwipeEnabled(box, r.ok); };
  upd();
  const amt = $("#amtIn"), lim = $("#limIn");
  if (amt) amt.oninput = () => { ui.sheet.amtSet = true; ui.sheet.amount = +amt.value; $$(".chips.amt button").forEach(b => b.setAttribute("aria-pressed", "false")); upd(); };
  if (lim) lim.oninput = () => { ui.sheet.limit = +lim.value; upd(); };
  bindSwipe(box, submitTrade);
  box._upd = upd;
}

let submitting = false;
async function submitTrade() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "inst" || submitting) return;
  const inst = instOf(sh.key);
  let now = appNow();
  const mkt = mstatus(inst.m, now);
  const margin = isMarginSide(sh.side);
  const spec = sh.side !== "sell"
    ? { side: "buy", type: sh.type, amount: Math.round(sh.amount * 100) / 100, limit: sh.limit }
    : { side: "sell", type: sh.type, frac: sh.frac, limit: sh.limit };
  submitting = true;
  try {
    if (margin && !mkt.open) throw new E.TradeError("Leveraged and short trades need an open market.");
    const cheat = sh.type === "market" && mkt.open ? await cheatPrice(sh.side, inst) : null;
    if (ui.sheet !== sh) return;
    now = appNow();
    const opts = cheat ? { price: cheat.px, tags: [cheat.name] } : {};
    const r = margin
      ? { trade: E.openMargin(S, inst, spec.amount, C.leverage(S), sh.side === "short" ? -1 : 1, quoteFor(sh.key), now, "manual", opts) }
      : E.placeOrder(S, inst, spec, quoteFor(sh.key), now, mkt, opts);
    if (cheat && r.trade) S.cheats.armed[cheat.id] = false;
    if (sh.side !== "sell") { CFG.lastBuy = spec.amount; saveCfg(); }
    sh.side = null;
    if (r.trade) { celebrate(r.trade); afterTrades([r.trade]); }
    else {
      const o = r.order;
      toast(o.type === "limit" ? `Limit order placed: ${o.side === "buy" ? "buy" : "sell"} ${inst.sym} at ${$px(inst, o.limit)}` : `Order placed: it fills at the market open`, "");
      vibrate(15);
      saveSoon(0);
      runChecks(sh.key);
      renderView(); renderSheet();
    }
  } catch (e) {
    toast(e.message, "down");
    vibrate(80);
  } finally {
    submitting = false;
  }
}

/** Golden entry, Perfect exit and Sniper: the fill price comes from real candles. null when none is armed. */
async function cheatPrice(side, inst) {
  const now = appNow();
  if (SIM && side !== "sell" && inst.m === "meme" && C.isArmed(S, "sniper")) {
    const wi = W.insts[inst.key], b = wi?.b1[0];
    if (!wi || !b || b[0] > wi.born + 10 * 60e3) throw new E.TradeError("Sniper: this coin is too old, its first candle is gone. Sniper stays armed.");
    return { id: "sniper", name: "Sniper", px: b[1] };
  }
  if (side !== "sell" && inst.m === "meme" && C.isArmed(S, "sniper")) {
    toast("🔭 Looking up its first candle on GeckoTerminal…");
    if (TEST && window.__firstCandle) return { id: "sniper", name: "Sniper", px: window.__firstCandle.o };
    try { const b = await dex.firstCandle(inst.pair, inst.born); return { id: "sniper", name: "Sniper", px: b.o }; }
    catch (e) {
      noteError(e);
      throw new E.TradeError(e.kind === "old" ? "Sniper: this coin is too old, GeckoTerminal no longer has its first candle. Sniper stays armed." : "Sniper: GeckoTerminal didn't send its first candle. Sniper stays armed.");
    }
  }
  if (side !== "sell" && C.isArmed(S, "golden")) return { id: "golden", name: "Golden entry", px: await extremePrice(inst, now - 15 * 60e3, "low") };
  if (side === "sell" && C.isArmed(S, "perfect")) {
    const st = mstatus(inst.m, now);
    return { id: "perfect", name: "Perfect exit", px: await extremePrice(inst, Math.max(RP.startOfDay(now), inst.m === "stock" ? st.since || 0 : 0), "high") };
  }
  return null;
}

/** Lowest (or highest) real price since `from`: source candles plus the live prices seen. It must cover the whole window. */
async function extremePrice(inst, from, kind) {
  const ivl = kind === "low" ? "1m" : "5m", ms = INTERVALS[ivl], now = appNow();
  let bars = [], whole = false;
  if (SIM) { const wi = W.insts[inst.key]; bars = wi ? SW.bars(wi, ivl) : []; whole = !!wi?.born && wi.born >= from - 60e3; }
  else if (!TEST) {
    try {
      if (inst.m === "crypto") bars = await crypto.candles(inst.id, ivl);
      else if (inst.m === "meme") { bars = await dex.candles(inst.pair, ivl); whole = bars.length > 0 && bars.length < 300; }
      else if (CFG.twelveKey) bars = (await td.series(tdSymbol(inst), ivl, { now, lastActive: H.lastActivity(inst.m, now) })).bars;
    } catch (e) { noteError(e); bars = []; }
  }
  const pts = bars.filter(b => b.t + ms > from).map(b => (kind === "low" ? b.l : b.h));
  let covered = bars.length > 0 && (bars[0].t <= from || whole || (inst.born && inst.born >= from));
  const tk = ticks.get(inst.key) || [];
  if (tk.length && tk[0].t <= from + 60e3) covered = true;
  pts.push(...tk.filter(x => x.t >= from).map(x => x.px));
  const q = quoteFor(inst.key);
  if (q) pts.push(q.px);
  if (!covered || !pts.length) {
    throw new E.TradeError(kind === "low" ? "Golden entry: there are no real prices for the whole last 15 minutes yet. It stays armed." : "Perfect exit: there are no real prices for the whole day yet. It stays armed.");
  }
  return kind === "low" ? Math.min(...pts) : Math.max(...pts);
}

// ---------------------------------------------------------------- cheats sheet
function cheatsHTML() {
  const now = appNow();
  const toggle = id => `<label class="sw"><input type="checkbox" data-cheat="${id}" ${C.isOn(S, id) ? "checked" : ""} ${id === "oracle" && !SIM ? "disabled" : ""} aria-label="${esc(C.CHEAT[id].name)}"><span></span></label>`;
  const armBtn = id => `<button class="btn sm ${C.isArmed(S, id) ? "on" : "ghost"}" data-arm="${id}" aria-pressed="${C.isArmed(S, id)}">${C.isArmed(S, id) ? "Armed ✓" : "Arm"}</button>`;
  const lastT = S.undo ? S.trades.filter(t => t.id > S.undo.seq).pop() : null;
  const win = C.lastWin(S);
  const bo = S.cheats?.boost;
  const memes = Object.values(S.pos).filter(p => p.inst.m === "meme");
  const leader = BOTS.length ? participants().find(x => x.id !== "me") : null;
  const tmList = tmChoices();
  const body = {
    printer: `<div class="chips">${C.PRINTER.map(n => `<button data-print="${n}">+${chipLabel(n)}</button>`).join("")}</div>`,
    leverage: `<div class="chips" role="group" aria-label="Leverage">${C.LEVERAGE.map(l => `<button data-lev="${l}" aria-pressed="${C.leverage(S) === l}">${l === 1 ? "Off" : l + "x"}</button>`).join("")}</div>`,
    undo: lastT ? `<button class="btn sm ghost" data-undo>Undo: ${sideLabel(lastT)} ${esc(lastT.sym)} ${$usd(lastT.usd)}</button>` : `<small class="mut">Nothing to undo yet: it works on your last trade.</small>`,
    don: (win ? `<button class="btn sm ghost" data-don>Flip on ${$usd(win.pl, { sign: true })} ${esc(win.sym)}</button>` : `<small class="mut">Close a trade in the green first: it works on your last trade.</small>`) + `<small class="mut">If you lose, your whole portfolio drops to $100.</small>`,
    moon: bo && now <= bo.until ? `<small class="mut">🌙 Running on ${esc(S.pos[bo.key]?.inst.sym || "")}: <b data-cd="${bo.until}">${countdown(bo.until - now)}</b> left. It pays at the end, at the last live price.</small>`
      : memes.length ? `<div class="chips">${memes.map(p => `<button data-moon="${esc(p.key)}">🌙 ${esc(p.inst.sym)}</button>`).join("")}</div>` : `<small class="mut">Hold a memecoin first.</small>`,
    airdrop: C.airdropReady(S, now) ? `<button class="btn sm ghost" data-airdrop>Claim today's airdrop (${$usd0(S.start * C.AIRDROP_SHARE)} of a random memecoin)</button>` : `<small class="mut">Already claimed today. The next one is tomorrow.</small>`,
    timeMachine: tmList.length ? `<label class="sel">Replay <select id="tmInst">${tmList.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("")}</select></label>
      <label class="sel">Day <select id="tmDay">${RP.replayDays(now).map(d => `<option value="${d.from}">${esc(d.label)}</option>`).join("")}</select></label>
      <button class="btn sm" data-tm>⏪ Start replay</button>
      <small class="mut">A separate replay portfolio of ${$usd0(S.start)}: your ${SIM ? "Sim" : "real"} one is not touched.${SIM ? " Sim history: minutes older than 6 hours are filled in from each hour's candle." : CFG.twelveKey ? "" : " Stocks and forex need the Twelve Data key."}</small>`
      : `<small class="mut">Waiting for the market lists…</small>`,
    timeSkip: `<small class="mut">Inside a Time machine replay: “+1 hour” and “+1 day”.</small>`,
    oracle: SIM ? `<small class="mut">${C.isOn(S, "oracle") ? "🔮 On: open any Sim coin and its chart shows the next 30 minutes, faded, with BUY and SELL = max profit." : "Turn it on, then open any Sim coin."}</small>
      <label class="tog"><input type="checkbox" id="oaTog" ${CFG.oracleAuto.on ? "checked" : ""}><span>Oracle Auto: buy at BUY and sell at SELL by itself</span></label>
      <label class="sel">Use <input id="oaPct" type="number" inputmode="decimal" min="1" max="100" step="1" value="${CFG.oracleAuto.pct}"> % of your cash each time</label>
      <div class="chips">${[["view", "The coin I'm viewing"], ["all", "Every coin with a mark"]].map(([k, l]) => `<button data-oascope="${k}" aria-pressed="${CFG.oracleAuto.scope === k}">${l}</button>`).join("")}</div>` : `<small class="sim-only">Sim only</small> <small class="mut">The real future isn't known: switch to Sim at the top of the screen.</small>`,
    copycat: leader ? `<button class="btn sm ghost" data-copycat="${esc(leader.id)}">Copy ${esc(leader.name)} (${$usd(leader.total)}, ${$pct(leader.plPct * 100)})</button>` : `<small class="mut">Add a rival bot first (Settings → Rival bots).</small>`,
  };
  const groups = [...new Set(C.CHEATS.map(c => c.group))];
  const always = id => C.ALWAYS.includes(id) ? `<button class="always-btn" data-always="${id}" aria-pressed="${C.isAlways(S, id)}">♾️ Always on${C.isAlways(S, id) ? " ✓" : ""}</button>` : "";
  const card = c => `<div class="cheat${C.isOn(S, c.id) || C.isArmed(S, c.id) || C.isAlways(S, c.id) || (c.id === "leverage" && C.leverage(S) > 1) ? " active" : ""}${C.isAlways(S, c.id) ? " always" : ""}">
      <div class="ch-top"><span class="ch-i" aria-hidden="true">${c.icon}</span><span class="nm"><b>${esc(c.name)}${C.isAlways(S, c.id) ? ` <i class="always-tag">ALWAYS ON</i>` : ""}</b><small>${esc(c.desc)}</small></span>
      ${c.kind === "toggle" ? toggle(c.id) : c.kind === "arm" ? armBtn(c.id) : ""}</div>
      ${body[c.id] || C.ALWAYS.includes(c.id) ? `<div class="ch-body">${body[c.id] || ""}${always(c.id)}</div>` : ""}</div>`;
  const alwaysList = C.ALWAYS.filter(id => C.isAlways(S, id)).map(id => C.CHEAT[id].name);
  return `<div class="sh-head"><span class="ico ico-bot" aria-hidden="true">🎮</span><div class="sh-title"><h2>Cheats</h2><small>Bots have their own list (Settings → Rival bots)</small></div><button class="close" data-close aria-label="Close">✕</button></div>
  <div class="sh-body cheats">
    <div class="cheat-note">${E.isCheated(S) ? `<b><span class="star">★</span> This portfolio is marked</b><small>Cheats used since ${dateTime(S.cheats.since)}. The star shows on the leaderboard and in your history, and achievements earned now are kept apart. Resetting the portfolio removes it.</small>`
      : `<b>Clean portfolio</b><small>Turning on, arming or using any cheat marks it with a ★ on the leaderboard and in your history, and achievements earned with cheats are kept apart. Resetting the portfolio removes the star.</small>`}</div>
    ${alwaysList.length ? `<div class="always-list">♾️ <b>Always on:</b> ${alwaysList.map(esc).join(", ")}</div>` : ""}
    ${groups.map(g => `<h3 class="sec">${esc(g)}</h3>${C.CHEATS.filter(c => c.group === g).map(card).join("")}`).join("")}
  </div>`;
}

/** What can be replayed: instruments the app has live, with a source of past 1-minute candles. */
function tmChoices() {
  const out = [];
  for (const L of live.values()) {
    const i = L.inst;
    if (!i?.key || !(L.px > 0) || !RP.replayable(i)) continue;
    if (!SIM && (i.m === "stock" || i.m === "fx") && !CFG.twelveKey) continue;
    if (!SIM && i.m === "meme" && !i.pair) continue;
    out.push({ key: i.key, label: `${i.sym} · ${MARKET_LABEL[i.m]}`, m: i.m });
  }
  const order = { crypto: 0, stock: 1, fx: 2, meme: 3 };
  return out.sort((a, b) => order[a.m] - order[b.m] || a.label.localeCompare(b.label)).slice(0, 120);
}

function cheatChanged() {
  saveSoon(0);
  oracleVer++;
  if (ui.sheet?.kind === "cheats" || ui.sheet?.kind === "bot") renderSheet();
  else if (ui.sheet?.kind === "inst") { const tb = $("#tradeBox"); if (tb && !ui.sheet.side) { tb.innerHTML = tradeBoxHTML(); bindTradeBox(); } }
  renderView(); refreshStandings(); frame();
}

function doAirdrop() {
  const now = appNow();
  const pool = [...live.values()].filter(L => L.inst?.m === "meme" && L.px > 0 && L.t && now - L.t < 10 * 60e3);
  if (!pool.length) { toast("Waiting for live memecoin prices for the airdrop…", "down"); kick("meme"); return; }
  const L = pool[Math.floor(rand() * pool.length)];
  try {
    const t = C.airdrop(S, L.inst, quoteFor(L.inst.key), now);
    toast(`🪂 Airdrop: ${$qty(t.qty)} ${esc(t.sym)} worth ${$usd(t.worth)}, free`, "gold");
    confetti($("#confetti")); vibrate([20, 30, 20]);
    afterTrades([t]);
  } catch (e) { toast(e.message, "down"); }
}

// ---------------------------------------------------------------- Time machine (replay)
let rpTimer = null, rpLast = 0;
function stopReplayTimer() { clearInterval(rpTimer); rpTimer = null; }
function startReplayTimer() {
  stopReplayTimer();
  rpLast = Date.now();
  rpTimer = setInterval(() => rpTick(Date.now()), 250);
}
function rpTick(now) {
  const rp = ui.replay;
  if (!rp || ui.sheet?.kind !== "replay") { stopReplayTimer(); return; }
  const before = RP.priceNow(rp)?.t;
  const moved = RP.advance(rp, now - rpLast);
  rpLast = now;
  if (!moved) return;
  if (RP.atEnd(rp)) { renderSheet(); return; }
  updateReplay(RP.priceNow(rp)?.t !== before);
}

async function startReplay(key, day, testBars) {
  const inst = instOf(key);
  if (!inst) return;
  const now = appNow(), w = RP.loadWindow(day, now);
  try {
    let bars = testBars;
    if (!bars) {
      if (SIM) { const wi = W.insts[key]; bars = wi ? SW.minuteHistory(wi, w.from, w.to) : []; }
      else { toast("⏪ Loading real 1-minute candles…"); }
      if (SIM) { /* Sim candles above */ }
      else if (inst.m === "crypto") bars = await crypto.history(inst.id, w.from, w.to);
      else if (inst.m === "meme") bars = await dex.history(inst.pair, w.from, w.to);
      else {
        if (!CFG.twelveKey) throw new E.TradeError("Stock and forex replays need the Twelve Data key (Settings).");
        bars = await td.history(tdSymbol(inst), w.from, w.to, now);
      }
    }
    ui.replay = RP.newReplay({ inst: { ...inst, liq: live.get(key)?.liq }, bars, day, start: S.start, now });
    openPanel({ kind: "replay" });
    startReplayTimer();
  } catch (e) {
    if (e.source) noteError(e);
    toast(e instanceof E.TradeError ? e.message : `Couldn't load the candles: ${e.message || "error"}`, "down");
  }
}

const rpClock = rp => new Date(Math.min(rp.t, rp.end)).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function rpStatsHTML(rp) {
  const t = RP.totals(rp), p = rp.pf.pos[rp.inst.key], q = RP.quote(rp);
  const v = p ? E.positionView(p, q, rp.pf) : null;
  return `<div class="sb-grid">
    <div><small>Replay portfolio</small><b>${$usd(t.total)}</b><small class="${dirCls(t.pl)}">${$usd(t.pl, { sign: true })} (${$pct(t.plPct * 100)})</small></div>
    <div><small>Cash</small><b>${$usd(t.cash)}</b><small>${plural(rp.pf.trades.length, "trade", "trades")}</small></div>
    <div><small>${esc(rp.inst.sym)} position</small><b>${v ? usd(v.value) : "—"}</b>${v ? `<small class="${dirCls(v.pl)}">${$usd(v.pl, { sign: true })} (${$pct(v.plPct * 100, 1)})</small>` : ""}</div>
    <div><small>Market then</small><b>${RP.marketOpen(rp) ? "Open" : "Closed"}</b></div>
  </div>`;
}
function replayHTML() {
  const rp = ui.replay, inst = rp.inst, q = RP.quote(rp), p = rp.pf.pos[inst.key];
  const speeds = RP.SPEEDS.map(x => `<button data-rpspeed="${x}" aria-pressed="${rp.speed === x}">${x}x</button>`).join("");
  return `<div class="sh-head">${icon(inst)}<div class="sh-title"><h2>⏪ ${esc(inst.sym)}</h2><small><span class="star">★</span> Time machine · replay portfolio, separate from yours</small></div><button class="close" data-close aria-label="Close">✕</button></div>
  <div class="sh-body replay">
    <div class="rp-clock" id="rpClock">${esc(rpClock(rp))}${rp.playing ? ` · ▶ ${rp.speed}x` : " · paused"}</div>
    <div class="big" id="rpPx">${q ? fmtPx(inst, q.px) : "—"}</div>
    <div class="rp-ctl">
      <button class="btn sm" data-rp="play" ${RP.atEnd(rp) ? "disabled" : ""}>${rp.playing ? "⏸ Pause" : "▶ Play"}</button>
      <div class="seg tiny">${speeds}</div>
    </div>
    <canvas id="rpChart" aria-label="${esc(inst.sym)} replay chart"></canvas>
    <div class="chart-note">Real 1-minute candles. The price is the close of the last finished minute.${rp.peek ? " Faded candles after the line: the next 5 minutes (Peek)." : ""}</div>
    <div class="rp-ctl">
      <button class="btn sm ${rp.peek ? "on" : "ghost"}" data-rp="peek" aria-pressed="${rp.peek}">👀 Peek 5 min</button>
      <button class="btn sm ghost" data-rp="hour" ${RP.atEnd(rp) ? "disabled" : ""}>⏩ +1 hour</button>
      <button class="btn sm ghost" data-rp="day" ${RP.atEnd(rp) ? "disabled" : ""}>⏩ +1 day</button>
    </div>
    ${RP.atEnd(rp) ? `<div class="banner">You've reached the present: the replay stops at the last real candle. Only the past.</div>` : ""}
    <section class="card" id="rpStats">${rpStatsHTML(rp)}</section>
    <div class="chips amt">${[0.01, 0.05, 0.1, 0.25].map(f => `<button data-rpbuy="${f}">Buy ${chipLabel(rp.pf.start * f)}</button>`).join("")}</div>
    <button class="btn wide danger" data-rp="sell" ${p ? "" : "disabled"}>Sell all ${esc(inst.sym)}</button>
    <h3 class="sec">Replay trades (${rp.pf.trades.length})</h3>
    <div class="list">${rp.pf.trades.slice().reverse().map(tradeItem).join("") || `<div class="empty sm">Buy and sell as the day replays. Costs are the same as in your real portfolio.</div>`}</div>
  </div>`;
}
function drawReplay() {
  const rp = ui.replay, c = $("#rpChart");
  if (!rp || !c) return;
  const vis = RP.visibleBars(rp).slice(-150), peek = rp.peek ? RP.peekBars(rp) : [];
  drawChart(c, [...vis, ...peek], { mode: CFG.chartMode, dp: rp.inst.m === "fx" ? (rp.inst.dp ?? FX_BY_ID[rp.inst.id]?.dp ?? 5) : null, ivl: "1m", ghost: peek.length, empty: "Waiting for the first candle of the day…" });
}
function updateReplay(newBar) {
  const rp = ui.replay;
  const ck = $("#rpClock"); if (ck) ck.textContent = rpClock(rp) + (rp.playing ? ` · ▶ ${rp.speed}x` : " · paused");
  if (!newBar) return;
  const q = RP.quote(rp);
  const px = $("#rpPx"); if (px) px.textContent = q ? fmtPx(rp.inst, q.px) : "—";
  const st = $("#rpStats"); if (st) st.innerHTML = rpStatsHTML(rp);
  drawReplay();
}
function replayAction(a) {
  const rp = ui.replay;
  if (!rp) return;
  if (a === "play") { rp.playing = !rp.playing && !RP.atEnd(rp); if (rp.playing) rp.peek = false; rpLast = Date.now(); renderSheet(); return; }
  if (a === "peek") { rp.peek = !rp.peek; if (rp.peek) rp.playing = false; renderSheet(); return; }
  if (a === "hour" || a === "day") {
    rp.playing = false;
    const end = RP.skip(rp, a === "hour" ? 3600e3 : 86400e3);
    const t = RP.totals(rp);
    toast(`⏩ ${a === "hour" ? "+1 hour" : "+1 day"}: ${esc(rpClock(rp))} · replay portfolio ${$usd(t.total)} (${$usd(t.pl, { sign: true })})${end ? " · you reached the present" : ""}`, t.pl >= 0 ? "up" : "down");
    renderSheet(); return;
  }
  try {
    if (a === "sell") { const t = RP.sell(rp); celebrate(t); }
    else { const usdAmt = Math.min(E.available(rp.pf), Math.round(rp.pf.start * +a * 100) / 100); const t = RP.buy(rp, usdAmt); toast(`Replay: bought ${$usd(t.usd)} of ${esc(t.sym)} at ${$px(rp.inst, t.px)}`, "up"); }
  } catch (e) { toast(e.message, "down"); }
  renderSheet();
}

// ---------------------------------------------------------------- chart
async function loadChart() {
  const sh = ui.sheet;
  if (!sh || sh.kind !== "inst") return;
  const inst = instOf(sh.key), ivl = sh.ivl;
  if (inst.m === "stock" && needFinnhub()) return;
  if (chart && (chart.src === "twelvedata" || chart.src === "cache")) td.saveLive(chart.sym, chart.ivl, chart.bars).catch(() => {});
  const token = {};
  chartToken = token;
  const tickBars = () => ticksToBars(ticks.get(sh.key) || [], ivl);
  if (SIM) {
    chart = { key: sh.key, ivl, bars: null, src: "sim", note: "Sim candles, generated since this one exists. Gold candles: a pump.", sym: inst.sym };
    setChartNote(chart.note); drawChartSoon(true); return;
  }
  chart = { key: sh.key, ivl, bars: tickBars(), src: "live", note: TEST ? "Test mode: chart from live prices." : "Loading candles…", sym: tdSymbol(inst) };
  setChartNote(chart.note); drawChartSoon(true);
  if (TEST) return;
  let bars, srcName, note;
  const now = appNow();
  try {
    if (inst.m === "crypto") {
      bars = await crypto.candles(inst.id, ivl);
      srcName = crypto.mode;
      note = `Live ${srcName === "binance" ? "Binance" : "Coinbase"} candles.`;
      if (srcName === "binance") crypto.watchChart(inst.id, ivl);
    } else if (inst.m === "meme") {
      bars = await dex.candles(inst.pair, ivl);
      srcName = "geckoterminal";
      note = "GeckoTerminal candles; the last one moves with DexScreener's live price.";
      if (bars.length < 2) throw new SourceError("geckoterminal", "notfound", "No candles");
    } else {
      if (!CFG.twelveKey) throw new SourceError("twelvedata", "nokey", "No key");
      const r = await td.series(tdSymbol(inst), ivl, { now, lastActive: H.lastActivity(inst.m, now) });
      bars = r.bars; srcName = r.src;
      const b = await td.status(now);
      note = (r.src === "cache" ? "Twelve Data candles saved on this phone (no credits used)" : "Twelve Data candles, saved on this phone") + ` · ${b.used} of ${DAILY_CAP} used today.` +
        (r.stale ? " Couldn't refresh them; showing the saved copy." : "");
    }
  } catch (e) {
    if (chartToken !== token) return;
    noteError(e);
    const fallback = "The chart uses live prices since you opened the app.";
    const msg = {
      geckoterminal: "GeckoTerminal has no candles for this coin. " + fallback,
      twelvedata: e.kind === "nokey" ? "No Twelve Data key: " + fallback.charAt(0).toLowerCase() + fallback.slice(1) + " Add it in Settings to see candles."
        : e.kind === "auth" ? "Twelve Data rejected your key (check Settings). " + fallback
        : e.kind === "limit" ? (e.body === "day" ? "Today's 800 Twelve Data candles are used up. " : "Twelve Data: wait a minute for more candles. ") + fallback
        : e.kind === "premium" ? "Twelve Data doesn't give candles for this symbol on the free plan. " + fallback
        : "No candles came from Twelve Data. " + fallback,
    }[e.source] || (e.kind === "offline" ? "Offline. " : "No candles came in. ") + fallback;
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
    let bars = chart.src === "sim" ? (W?.insts[chart.key] ? SW.bars(W.insts[chart.key], chart.ivl) : []) : chart.src === "live" ? ticksToBars(ticks.get(chart.key) || [], chart.ivl) : chart.bars;
    let ghost = 0, marks = [];
    if (chart.src === "sim") {
      const o = oracleFor(chart.key);
      if (o?.inst && bars.length) {
        const lastT = bars[bars.length - 1].t;
        const fut = SW.bars(o.inst, chart.ivl).filter(b => b.t > lastT);
        ghost = fut.length; bars = bars.concat(fut);
        if (o.best) marks = [{ t: o.best.buy.t, px: o.best.buy.px, label: "BUY", kind: "buy" }, { t: o.best.sell.t, px: o.best.sell.px, label: "SELL = max profit", kind: "sell" }];
      }
      oracleNote(o, inst);
    }
    drawChart(c, bars, { mode: CFG.chartMode, dp: inst?.m === "fx" ? (inst.dp ?? 5) : null, ivl: chart.ivl, ghost, ghostLabel: "Oracle", marks, empty: chart.src === "live" ? "The chart is drawn from live prices while you have the app open." : "" });
  };
  if (now) return run();
  if (chartTimer) return;
  chartTimer = setTimeout(run, Math.max(0, 250 - (Date.now() - chartDrawAt)));
}

// ---------------------------------------------------------------- sheet: settings
function resetHTML() {
  const st = ui.resetStart, okAmt = E.validStart(st);
  return `<h3>Reset portfolio</h3>
      <p class="mut">${SIM ? "This resets your <b>Sim</b> portfolio only; Live is not touched. " : ""}Start over with a new balance. Positions, orders, history and the cheats ★ are erased; achievements stay. Rival bots restart with the same balance. Export first if you want to keep your history.</p>
      <p class="lbl">Starting balance</p>
      <div class="chips start" role="group" aria-label="Starting balance">${START_CHOICES.map(n => `<button data-start="${n}" aria-pressed="${!ui.resetCustom && st === n}">${$usd0(n)}</button>`).join("")}<button data-start="custom" aria-pressed="${ui.resetCustom}">Custom</button></div>
      ${ui.resetCustom ? `<label class="amt-in">Amount in dollars (${$usd0(START_MIN)} to ${$usd0(START_MAX)}) <input id="startIn" type="number" inputmode="decimal" step="any" min="${START_MIN}" max="${START_MAX}" value="${st || ""}"></label>` : ""}
      <button class="btn danger" data-reset ${okAmt ? "" : "disabled"}>${okAmt ? `Reset to ${$usd0(st)}` : "Enter an amount"}</button>`;
}
function renderReset() { const el = $("#resetBox"); if (el) el.innerHTML = resetHTML(); }

function settingsHTML() {
  const ns = notifySupport();
  const perm = ns.ok ? { granted: "Allowed ✓", denied: "Blocked in the browser", default: "Not allowed yet" }[ns.permission] : ns.why;
  const tog = (k, label) => `<label class="tog"><input type="checkbox" data-notif="${k}" ${CFG.notif[k] ? "checked" : ""}><span>${label}</span></label>`;
  const keyRow = (id, label, val, link, linkText) => `<div class="keyrow">
      <label for="${id}">${label}</label>
      <div class="key-in"><input id="${id}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your key here" value="${val ? "••••••••" + esc(val.slice(-4)) : ""}" data-masked="${val ? 1 : 0}"><button class="btn" data-savekey="${id}">Save</button></div>
      <small>Create one for free at <a href="${link}" target="_blank" rel="noopener">${linkText}</a>. It's saved only on this phone; it never goes in the backup or any file. ${val ? `<button class="lnk" data-delkey="${id}">Delete key</button>` : ""}</small>
      <small class="key-status" id="${id}-st"></small>
    </div>`;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return `<div class="sh-head"><div class="sh-title"><h2>Settings</h2><small>Everything is saved only on this phone</small></div><button class="close" data-close aria-label="Close">✕</button></div>
  <div class="sh-body settings">
    <section class="card"><h3>Price keys</h3>
      ${keyRow("fhKey", "Finnhub (stocks)", CFG.finnhubKey, FINNHUB_SIGNUP, "finnhub.io/register")}
      ${keyRow("tdKey", "Twelve Data (stock and forex candles, optional)", CFG.twelveKey, TWELVE_SIGNUP, "twelvedata.com/register")}
      <small class="mut" id="tdBudget"></small>
    </section>
    <section class="card"><h3>Phone notifications</h3>
      <p class="mut">Permission: <b>${esc(perm)}</b></p>
      ${ns.ok && ns.permission !== "granted" ? `<button class="btn" data-askperm>Allow notifications</button>` : ""}
      ${tog("fills", "Limit order fills, stop loss and take profit")}
      ${tog("moves", "Big moves in what you hold")}
      <label class="sel">Notify if it moves more than <select id="moveTh">${[3, 5, 10, 20].map(n => `<option value="${n}" ${CFG.moveTh === n ? "selected" : ""}>${n}%</option>`).join("")}</select> in 1 hour</label>
      ${tog("price", "My price alerts (“NVDA hit $X”)")}
      ${tog("summary", "Summary at the Wall Street close")}
      ${tog("streak", "Streaks (“4 green days in a row”)")}
      <small class="mut">They arrive while the app is open or recently minimized. With the app fully closed it would need a notification server, which this version doesn't have. On iPhone, add the app to the Home Screen (iOS 16.4 or later).</small>
      ${CFG.alerts.length ? `<h4>Active price alerts</h4>${CFG.alerts.map(a => `<div class="alert-row">${esc(a.inst.sym)}: ${a.dir === "above" ? "if it rises to" : "if it falls to"} ${$px(a.inst, a.price)} <button class="lnk" data-delalert="${a.id}">remove</button></div>`).join("")}` : ""}
    </section>
    <section class="card" id="capBox"><h3>Money cap</h3>
      <p class="mut">No portfolio (yours in Live, yours in Sim, or a bot's) can be worth more than the combined fortune of the world's 100 richest people: <b>${$usd(RICH.WORLD_CAP)}</b>. If a gain would pass it, the portfolio stays at the cap with a “World's richest” notice.</p>
      <small class="mut">Figure: ${RICH.SOURCE}, ${richDate()} (a snapshot; Trophies shows where you'd rank).</small>
    </section>
    <section class="card" id="lcBox"><h3>Last chance</h3>
      <p class="mut">After you buy, the app follows the highest price since your buy (the lowest, for a short). If it falls this much from there:</p>
      <div class="chips" role="group" aria-label="Drop from the high">${[5, 10, 15, 20, 30].map(n => `<button data-lcpct="${n}" aria-pressed="${CFG.lc.pct === n}">−${n}%</button>`).join("")}</div>
      <label class="sel">Or exactly <input id="lcPct" type="number" inputmode="decimal" min="1" max="90" step="0.5" value="${CFG.lc.pct}"> %</label>
      <label class="tog"><input type="checkbox" id="lcWarn" ${CFG.lc.warn ? "checked" : ""}><span>Big “Last chance” warning with a Sell button</span></label>
      <label class="tog"><input type="checkbox" id="lcTrail" ${CFG.lc.trail ? "checked" : ""}><span>Trailing stop: sell automatically at that drop instead</span></label>
      <small class="mut">Live and Sim, everything you hold (leveraged too). Stocks and forex sell only while their market is open.</small>
    </section>
    <section class="card"><h3>Sound</h3>${`<label class="tog"><input type="checkbox" id="soundTog" ${CFG.sound ? "checked" : ""}><span>Sounds when trading (Live)</span></label>`}
      <label class="tog"><input type="checkbox" id="simSoundTog" ${CFG.simSound ? "checked" : ""}><span>Sim sounds: buys, sales, pumps, rugs, events and jackpots</span></label></section>
    <section class="card" id="botsBox">${botsSettingsHTML()}</section>
    <section class="card" id="cheatsBox"><h3>Cheats</h3>
      <p class="mut">Money printer, Zero fees, Leverage, Undo, Time machine and ${C.CHEATS.length - 5} more. Using any cheat marks your portfolio with a ★ on the leaderboard and in your history, and achievements earned with cheats are kept apart. Bots cheat too (Settings → Rival bots). Resetting the portfolio removes the star.</p>
      ${E.isCheated(S) ? `<p class="mut"><span class="star">★</span> This portfolio has used cheats.</p>` : ""}
      <button class="btn" data-cheats>Open cheats</button>
    </section>
    <section class="card"><h3>Backup</h3>
      <p class="mut">Export a file with your portfolio, history, achievements and rival bots, and open it on the other device with “Import”. Keys are not included in the file.</p>
      <div class="two"><button class="btn" data-export>Export file</button><label class="btn ghost file">Import file<input type="file" id="importIn" accept="application/json,.json" hidden></label></div>
    </section>
    <section class="card"><h3>Install on your phone</h3>
      ${standalone ? `<p class="mut">Already installed ✓</p>` : installPrompt ? `<button class="btn" data-install>Install Ghost Desk</button>` :
        `<p class="mut">${isIOS ? "In Safari, tap Share ⬆️ and then “Add to Home Screen”." : "In Chrome, tap the ⋮ menu and then “Install app” or “Add to Home screen”."}</p>`}
    </section>
    <section class="card danger-zone" id="resetBox">${resetHTML()}</section>
    <p class="foot">Sources: DexScreener and GeckoTerminal (memecoins), CoinGecko and Binance or Coinbase (crypto), Finnhub (stocks), Twelve Data (stock and forex candles), Coinbase (forex). Fake money, real prices. Nothing here is a recommendation.</p>
  </div>`;
}

function bindSettings() {
  td.status().then(b => { const el = $("#tdBudget"); if (el && CFG.twelveKey) el.textContent = `Twelve Data: ${b.used} of ${DAILY_CAP} candles used today (the limit resets at midnight UTC).`; }).catch(() => {});
  for (const id of ["fhKey", "tdKey"]) {
    const inp = $("#" + id);
    inp.addEventListener("focus", () => { if (inp.dataset.masked === "1") { inp.value = ""; inp.dataset.masked = "0"; } });
  }
}

async function saveKey(id) {
  const inp = $("#" + id), st = $("#" + id + "-st");
  if (inp.dataset.masked === "1") { st.textContent = "Paste a new key to change it."; return; }
  const val = inp.value.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(val)) { st.textContent = "That doesn't look like a key (letters and numbers only)."; st.className = "key-status down"; return; }
  st.textContent = "Testing the key…"; st.className = "key-status";
  const prev = id === "fhKey" ? CFG.finnhubKey : CFG.twelveKey;
  if (id === "fhKey") CFG.finnhubKey = val; else CFG.twelveKey = val;
  try {
    if (id === "fhKey") { await stockQuote("SPY"); okSrc("finnhub"); }
    else { await td._fetchSeries("AAPL", "1d", Date.now()); okSrc("twelvedata"); }
    st.textContent = "Key saved and working ✓"; st.className = "key-status up";
  } catch (e) {
    if (e.kind === "auth") {
      if (id === "fhKey") CFG.finnhubKey = prev; else CFG.twelveKey = prev;
      st.textContent = `${id === "fhKey" ? "Finnhub" : "Twelve Data"} rejected that key. Make sure you copied all of it.`; st.className = "key-status down";
      return;
    }
    st.textContent = e.kind === "limit" ? "Key saved. The source is at its limit right now; it will be tested again in a minute." : "Key saved. It couldn't be tested right now (connection?); it will be tested again on its own.";
  }
  await saveCfg();
  if (id === "fhKey") { fh.reset(); stockListAt = 0; statusAt = 0; lists.stock = []; kick("stock"); }
  src[id === "fhKey" ? "finnhub" : "twelvedata"] = { ok: Date.now(), err: null };
  renderBanners(); renderView();
  setTimeout(() => { if (ui.sheet?.kind === "settings") renderSheet(); }, 1500);
}

/** MM-DD-YYYY for file names (US order, no slashes). */
function fileDay(ms) {
  const [y, m, d] = localDay(ms).split("-");
  return `${m}-${d}-${y}`;
}

function exportBackup() {
  const text = buildBackup({ portfolio: S, achievements: A, settings: CFG, bots: BOTS });
  download(`ghost-desk-backup-${fileDay(Date.now())}.json`, text, "application/json");
  toast("Backup exported", "up");
}
async function importBackup(file) {
  try {
    const text = await file.text();
    const d = parseBackup(text);
    S = d.portfolio; S.undoable = true;
    if (SIM) { await clearPoints(); addPoint(); }
    if (d.achievements) A = mergeAchievements(A, d.achievements);
    if (d.bots) BOTS = d.bots;
    const keep = { finnhubKey: CFG.finnhubKey, twelveKey: CFG.twelveKey };
    CFG = { ...DEFAULT_CFG, ...d.settings, ...keep, notif: { ...DEFAULT_CFG.notif, ...(d.settings.notif || {}) } };
    DUE.add("portfolio"); DUE.add("bots"); DUE.add("achievements");
    if (!(await saveCfg())) throw new Error("The backup was read but could not be saved.");
    toast(`Backup imported: ${plural(Object.keys(S.pos).length, "position", "positions")}, ${plural(S.trades.length, "trade", "trades")}${BOTS.length ? ", " + plural(BOTS.length, "bot", "bots") : ""}`, "up");
    closeSheet();
    renderAll();
    for (const m of MARKETS) kick(m === "stock" ? "stock" : m);
  } catch (e) {
    toast(e.message || "Could not import", "down");
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
  if (SIM) { lists.search[m] = SW.search(W, m, q) || []; ui.searching = false; if (ui.tab === "markets" && ui.market === m) renderView(); return; }
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
    toast(e.kind === "offline" ? "Offline" : `Search failed: ${e.message?.toLowerCase() || "error"}`, "down");
  }
  ui.searching = false;
  if (ui.tab === "markets" && ui.market === m) renderView();
}

// ---------------------------------------------------------------- events
function onClick(e) {
  const t = e.target.closest("button, [data-open], a, label");
  if (!t) return;
  const d = t.dataset;
  if (d.open) { openSheet(d.open); return; }
  if (d.setmode) { setMode(d.setmode); return; }
  if (d.lcpct) { CFG.lc.pct = +d.lcpct; saveCfg(); const i = $("#lcPct"); if (i) i.value = CFG.lc.pct; $$("[data-lcpct]").forEach(b => b.setAttribute("aria-pressed", b.dataset.lcpct === d.lcpct)); return; }
  if (d.lcsell !== undefined) { lastChanceSell(); return; }
  if (d.lckeep !== undefined) { hideLastChance(); return; }
  if (d.skip) { skipAhead(d.skip); return; }
  if (d.rewind) {
    if (!t.dataset.sure) {
      if (!findPoint((W?.t || 0) - RW.REWINDS[d.rewind])) { rewind(d.rewind); return; }
      t.dataset.sure = "1"; t.textContent = `Sure? −${d.rewind}`;
      toast("Everything in Sim since then is lost. Tap again to rewind.");
      setTimeout(() => { if (t.isConnected) { delete t.dataset.sure; t.textContent = `−${d.rewind}`; } }, 4000);
      return;
    }
    delete t.dataset.sure; t.textContent = `−${d.rewind}`;
    rewind(d.rewind); return;
  }
  if (d.doit) { doIt(d.doit); return; }
  if (d.jumpbuy) { jumpBuy(d.jumpbuy); return; }
  if (d.jumpsell) { jumpSell(d.jumpsell); return; }
  if (d.disarm) { dropSignal(d.disarm); oracleVer++; toast("Signal canceled"); drawChartSoon(true); return; }
  if (d.oascope) { CFG.oracleAuto.scope = d.oascope; saveCfg(); cheatChanged(); return; }
  if (d.frpct) { CFG.frontPct = +d.frpct; saveCfg(); refreshStandings(); renderSheet(); return; }
  if (d.front) { frontRun(d.front, false, d.key); return; }
  if (d.sellfirst) { frontRun(d.sellfirst, true, d.key); return; }
  if (d.skipok !== undefined) { $("#skipBox").hidden = true; return; }
  if (d.bot) { openBot(d.bot); return; }
  if (d.cheats !== undefined) { openPanel({ kind: "cheats" }); return; }
  if (d.donno !== undefined) { $("#confirm").hidden = true; return; }
  if (d.always) { C.setAlways(S, d.always, !C.isAlways(S, d.always), appNow()); toast(C.isAlways(S, d.always) ? `♾️ ${C.CHEAT[d.always].name}: always on` : `${C.CHEAT[d.always].name}: always on is off`, "gold"); cheatChanged(); return; }
  if (d.arm || d.lev || d.print || d.undo !== undefined || d.don !== undefined || d.donflip !== undefined || d.moon || d.airdrop !== undefined || d.copycat || d.closem) { cheatClick(t, d); return; }
  if (d.tm !== undefined) { startReplay($("#tmInst")?.value, +$("#tmDay")?.value); return; }
  if (d.rp) { replayAction(d.rp); return; }
  if (d.rpbuy) { replayAction(d.rpbuy); return; }
  if (d.rpspeed) { const rp = ui.replay; if (rp) { rp.speed = +d.rpspeed; rp.playing = !RP.atEnd(rp); rp.peek = false; rpLast = Date.now(); renderSheet(); } return; }
  if (d.addbot) { addBot(d.addbot); renderBotsBox(); return; }
  if (d.delbot) {
    if (!t.dataset.sure) {
      t.dataset.sure = "1"; t.textContent = "Tap again";
      setTimeout(() => { if (t.isConnected) { delete t.dataset.sure; t.textContent = "Remove"; } }, 5000);
      return;
    }
    const b = BOTS.find(x => x.id === d.delbot);
    BOTS = BOTS.filter(x => x.id !== d.delbot); saveBots();
    if (b) toast(`${b.name} removed`);
    renderBotsBox(); renderView(); return;
  }
  if (d.tab) { setTab(d.tab); return; }
  if (d.market) { ui.market = d.market; if (ui.tab !== "markets") setTab("markets"); else renderView(); ensureMarketLoaded(); return; }
  if (d.memeview) { ui.memeView = d.memeview; renderView(); kick("meme"); return; }
  if (d.clear !== undefined) { lists.search[ui.market] = null; ui.query[ui.market] = ""; renderView(); return; }
  if (d.hist) { ui.hist = d.hist; ui.histN = 100; renderView(); return; }
  if (d.sb) { ui.sb = d.sb; renderView(); return; }
  if (d.more !== undefined) { ui.histN += 200; renderView(); return; }
  if (d.csv !== undefined) {
    const list = S.trades.filter(x => ui.hist === "all" || x.m === ui.hist);
    download(`ghost-desk-history-${ui.hist}-${fileDay(Date.now())}.csv`, toCSV(list), "text/csv;charset=utf-8");
    return;
  }
  if (d.cancel) { if (E.cancelOrder(S, +d.cancel)) { toast("Order canceled"); saveSoon(0); renderView(); renderSheet(); } return; }
  if (d.settings !== undefined) { openSettings(); return; }
  if (d.close !== undefined) { closeSheet(); return; }
  if (d.ivl) { ui.sheet.ivl = d.ivl; CFG.ivl = d.ivl; saveCfg(); $$("[data-ivl]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ivl === d.ivl)); if (ui.sheet.key.startsWith("crypto:")) crypto.watchChart(null); loadChart(); return; }
  if (d.mode) { CFG.chartMode = d.mode; saveCfg(); $$("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === d.mode)); drawChartSoon(true); return; }
  if (d.side) {
    const sh = ui.sheet, q = quoteFor(sh.key);
    sh.side = d.side; sh.type = "market"; sh.frac = 1;
    sh.limit = q ? +(q.px * (d.side === "buy" ? 0.98 : 1.02)).toPrecision(6) : null;
    sfx("tap");
    $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return;
  }
  if (d.back !== undefined) { ui.sheet.side = null; $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return; }
  if (d.type) { ui.sheet.type = d.type; $("#tradeBox").innerHTML = tradeBoxHTML(); bindTradeBox(); return; }
  if (d.amt) {
    ui.sheet.amtSet = true;
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
    if (q && sl && sl >= q.px) { toast("The stop loss has to be below the current price.", "down"); return; }
    if (q && tp && tp <= q.px) { toast("The take profit has to be above the current price.", "down"); return; }
    E.setStops(S, key, { sl, tp }); saveSoon(0);
    toast(sl || tp ? "Stop loss and take profit saved" : "Stop loss and take profit removed", "up");
    renderSheet(); renderView(); return;
  }
  if (d.delalert) { CFG.alerts = CFG.alerts.filter(a => a.id !== +d.delalert); saveCfg(); renderSheet(); return; }
  if (d.savekey) { saveKey(d.savekey); return; }
  if (d.delkey) {
    if (d.delkey === "fhKey") { CFG.finnhubKey = ""; fh.reset(); } else CFG.twelveKey = "";
    saveCfg(); src[d.delkey === "fhKey" ? "finnhub" : "twelvedata"] = {}; renderSheet(); renderBanners(); renderView(); return;
  }
  if (d.askperm !== undefined) { askPermission().then(() => renderSheet()); return; }
  if (d.savenow !== undefined) { flushSave(); return; }
  if (d.reload !== undefined) { location.reload(); return; }
  if (d.issuesok !== undefined) { loadIssues = []; renderBanners(); return; }
  if (d.export !== undefined) { exportBackup(); return; }
  if (d.install !== undefined) { installPrompt?.prompt(); installPrompt = null; return; }
  if (d.start) {
    if (d.start === "custom") { ui.resetCustom = true; renderReset(); $("#startIn")?.focus(); }
    else { ui.resetCustom = false; ui.resetStart = +d.start; renderReset(); }
    return;
  }
  if (d.reset !== undefined) {
    const start = ui.resetStart;
    if (!E.validStart(start)) { toast(`Enter a starting balance between ${$usd0(START_MIN)} and ${$usd0(START_MAX)}.`, "down"); return; }
    if (!t.dataset.sure) {
      t.dataset.sure = "1"; t.textContent = `Tap again to erase everything and start with ${usd0(start)}`;
      setTimeout(() => { if (t.isConnected) { delete t.dataset.sure; t.textContent = `Reset to ${usd0(ui.resetStart)}`; } }, 5000);
      return;
    }
    S = E.newPortfolio(appNow(), start); S.undoable = true; saveSoon(0);
    resetBots(S.start, appNow());
    if (SIM) clearPoints().then(() => addPoint()).catch(e => console.warn(e?.message));
    CFG.lastBuy = defaultBuy(S.start); saveCfg();
    toast(`Portfolio reset: ${$usd0(S.start)}. Your achievements stay.`, "up");
    closeSheet(); renderAll(); return;
  }
}

function cheatClick(t, d) {
  const now = appNow();
  try {
    if (d.arm) { C.arm(S, d.arm, !C.isArmed(S, d.arm), now); if (C.isArmed(S, d.arm)) toast(`${C.CHEAT[d.arm].icon} ${C.CHEAT[d.arm].name} armed`, "gold"); }
    else if (d.lev) { C.setLeverage(S, +d.lev, now); toast(+d.lev > 1 ? `⚙️ Leverage ${d.lev}x: your buys open leveraged positions` : "Leverage off"); }
    else if (d.print) { const cut = C.printMoney(S, +d.print, now); if (cut) { capSeen = S.capCut; worldsRichest(cut); } else toast(`🖨️ ${$usd0(+d.print)} printed into your cash`, "gold"); confetti($("#confetti")); }
    else if (d.undo !== undefined) { const gone = C.undo(S, now); toast(`↩️ Undone: ${gone.map(x => `${sideLabel(x)} ${esc(x.sym)}`).join(", ") || "last trade"}`, "gold"); }
    else if (d.don !== undefined) { askDon(); return; }
    else if (d.donflip !== undefined) {
      $("#confirm").hidden = true;
      const r = C.doubleOrNothing(S, rand(), now);
      bigResult($("#result"), { text: r.won ? usd(r.gain * 2, { sign: true }) : usd(C.DON_FLOOR), sub: r.won ? `🪙 Heads: the profit doubled · ${r.trade.sym}` : `🪙 Tails: your whole portfolio dropped to ${usd(C.DON_FLOOR)}`, win: r.won });
      if (r.won) { confetti($("#confetti")); sfx("win"); } else { shake($("#app")); sfx("loss"); }
    }
    else if (d.moon) { C.startBoost(S, d.moon, quoteFor(d.moon)?.px, now); toast(`🌙 Moon boost: gains on ${esc(S.pos[d.moon].inst.sym)} count 3x for 10 minutes`, "gold"); }
    else if (d.airdrop !== undefined) { doAirdrop(); }
    else if (d.copycat) {
      if (!t.dataset.sure) { t.dataset.sure = "1"; const old = t.textContent; t.textContent = "Tap again: your positions are replaced"; setTimeout(() => { if (t.isConnected) { delete t.dataset.sure; t.textContent = old; } }, 5000); return; }
      const bot = BOTS.find(b => b.id === d.copycat);
      C.copycat(S, bot, now); toast(`🐒 Copycat: your portfolio is now a copy of ${esc(bot.name)}'s`, "gold");
    }
    else if (d.closem) {
      const m = S.margin?.[d.closem]; if (!m) return;
      if (!mstatus(m.inst.m, now).open) throw new E.TradeError("The market is closed: it can be closed when it opens.");
      const q = quoteFor(m.key); if (!q) throw new E.TradeError("No live price to close at.");
      const tr = E.closeMargin(S, m.id, 1, q, now, "manual");
      celebrate(tr); afterTrades([tr]); return;
    }
  } catch (e) { toast(e.message, "down"); vibrate(60); }
  cheatChanged();
}

function onSubmit(e) {
  const f = e.target;
  e.preventDefault();
  if (f.matches("[data-search]")) { clearTimeout(searchTimer); runSearch(ui.market, f.querySelector("input").value); return; }
  if (f.matches("[data-alertform]")) {
    const v = +$("#alertIn").value, key = ui.sheet.key, q = quoteFor(key), inst = instOf(key);
    if (!(v > 0)) { toast("Enter a price.", "down"); return; }
    if (!q) { toast("Wait for the live price to create the alert.", "down"); return; }
    CFG.alerts.push({ id: Date.now(), key, inst: E.slimInst(inst), dir: v >= q.px ? "above" : "below", price: v, createdAt: Date.now() });
    saveCfg();
    const ns = notifySupport();
    toast(`Alert set: ${inst.sym} at ${$px(inst, v)}` + (ns.ok && ns.permission !== "granted" ? ". Allow notifications in Settings to get it on your phone." : ""), "up");
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
  if (t.id === "startIn") {
    ui.resetStart = +t.value;
    const b = $("[data-reset]"), okAmt = E.validStart(ui.resetStart);
    if (b) { delete b.dataset.sure; b.disabled = !okAmt; b.textContent = okAmt ? `Reset to ${usd0(ui.resetStart)}` : "Enter an amount"; }
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.notif) { CFG.notif[t.dataset.notif] = t.checked; saveCfg(); return; }
  if (t.id === "moveTh") { CFG.moveTh = +t.value; saveCfg(); return; }
  if (t.id === "botCheatsTog") { CFG.botCheats = t.checked; saveCfg(); for (const b of BOTS) botCheatTick(b, appNow(), { allowed: CFG.botCheats, quoteFor }); saveBots(); refreshStandings(); return; }
  if (t.id === "lcPct") { const v = +t.value; if (v >= 1 && v <= 90) { CFG.lc.pct = v; saveCfg(); $$("[data-lcpct]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.lcpct === v)); } else toast("Choose between 1% and 90%.", "down"); return; }
  if (t.id === "lcWarn") { CFG.lc.warn = t.checked; saveCfg(); return; }
  if (t.id === "lcTrail") { CFG.lc.trail = t.checked; saveCfg(); toast(t.checked ? `Trailing stop on: it sells at −${CFG.lc.pct}% from the high since you bought.` : "Trailing stop off."); for (const k of trackedKeys()) runChecks(k); return; }
  if (t.dataset.cheat === "oracle" && !SIM) { t.checked = false; toast("Oracle works only in Sim mode.", "down"); return; }
  if (t.dataset.cheat) { C.setToggle(S, t.dataset.cheat, t.checked, appNow()); if (t.checked) toast(`${C.CHEAT[t.dataset.cheat].icon} ${C.CHEAT[t.dataset.cheat].name} on`, "gold"); cheatChanged(); return; }
  if (t.id === "oaTog") {
    CFG.oracleAuto.on = t.checked; saveCfg();
    if (t.checked && !C.isOn(S, "oracle")) C.setToggle(S, "oracle", true, appNow());
    if (t.checked) C.mark(S, "oracle", "Oracle Auto on", appNow());
    else for (const [k, g] of Object.entries(signals())) if (g.src === "auto") delete S.cheats.auto[k];
    toast(t.checked ? "🔮 Oracle Auto on" : "Oracle Auto off: what it bought stays yours.", t.checked ? "gold" : "");
    cheatChanged(); return;
  }
  if (t.id === "oaPct") { const v = +t.value; if (v >= 1 && v <= 100) { CFG.oracleAuto.pct = v; saveCfg(); } else { t.value = CFG.oracleAuto.pct; toast("Choose between 1% and 100%.", "down"); } return; }
  if (t.id === "simSoundTog") { CFG.simSound = t.checked; saveCfg(); if (t.checked) sounds.pump(); return; }
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
  if (ui.tab === "markets" || ui.tab === "home") {
    if (ui.market === "meme" || ui.tab === "home") kick("meme");
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
  SIM = (await kv.get("mode")) === "sim";
  document.body.classList.toggle("sim", SIM);
  const now0 = Date.now();
  S = await loadClean(K("portfolio"), (v, is) => (v == null ? null : CLEAN.cleanPortfolio(v, now0, is))) || E.newPortfolio(appNow());
  S.undoable = true;
  A = await loadClean(K("achievements"), (v, is) => CLEAN.cleanAchievements(v, now0, is));
  BOTS = await loadClean(K("bots"), (v, is) => CLEAN.cleanBots(v == null ? null : v.list ?? v, now0, is));
  CFG = await loadClean("settings", (v, is) => CLEAN.cleanSettings(v, DEFAULT_CFG, is));
  for (const p of [...Object.values(S.pos), ...E.marginPositions(S)]) if (!live.get(p.key) && p.lastPx) live.set(p.key, { inst: { ...p.inst }, px: null });
  const h = location.hash.slice(1);
  if (TABS.includes(h)) ui.tab = h;
  document.addEventListener("click", e => {
    const ab = e.target.closest?.(".ab");
    if (!ab?.dataset.full || e.target.closest(".btn, .chips, .swipe, .bs, .seg, .sw, .tog")) return;
    e.preventDefault(); e.stopPropagation();
    toast(`${esc(ab.dataset.full)}`);
  }, true);
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
    if (document.hidden) { saveOnExit(); return; }
    for (const n in loops) kick(n);
    renderAll();
  });
  addEventListener("pagehide", saveOnExit);
  if (SIM) await loadSim();
  // Ask the browser not to clear this data on its own (some only grant it after a tap).
  const persist = () => navigator.storage?.persist?.().catch(() => false);
  persist();
  document.addEventListener("click", persist, { once: true });
  renderAll();
  setInterval(secondTick, 1000);
  if (TEST) { setupTestHooks(); return; }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  startSources();
}

function setupTestHooks() {
  window.ghostDesk = {
    state: () => S, setLive, openSheet, openSettings, closeSheet, setTab, renderAll,
    bots: () => BOTS, botTick, addBot, openBot,
    C, E, SW, sim: () => W, rec: () => REC, isSim: () => SIM, simAdvance, setMode, skipAhead, oracleFor, appNow, cfg: () => CFG, RICH, askDon, botExtreme, afterTrades,
    simForce: type => { const ev = SW.forceEvent(W, type, W.t); simEvents([{ kind: "event", ev }]); return ev; },
    showJackpot: (sym, mult, gain) => showJackpot(sym, mult, gain, appNow()),
    openCheats: () => openPanel({ kind: "cheats" }), startReplay, replay: () => ui.replay, rpTick, runChecks, ticks,
    chooseSide: side => $(`[data-side="${side}"]`)?.click(),
    lists, live, kv, saveSoon, saveOnExit, rewind, points: () => PTS, signals, doIt, jumpBuy, jumpSell, frontRun, nextMoves, forecast, SAVE: flushSave, refreshStandings,
  };
  document.documentElement.dataset.ready = "1";
}

boot().catch(e => {
  console.error(e);
  $("#view").innerHTML = `<div class="banner err">Ghost Desk couldn't start: ${esc(e?.message || e)}. Reload the page.</div>`;
});
