// Spec tests 1–5 with hand-made prices (no network). Test 6 (375 px) is run by run.py.
// Expected numbers were computed by hand, independently of the app code.

import * as E from "../js/core/engine.js";
import * as H from "../js/core/hours.js";
import { quoteBuy, quoteSell, markValue, START_CASH, START_CHOICES } from "../js/core/money.js";
import { scoreboard, greenStreak, toCSV, localDay, usDateTime } from "../js/core/stats.js";
import { newAchievements, evaluate, ACHIEVEMENTS } from "../js/core/achievements.js";
import { applyTick, cacheIsFresh, ticksToBars } from "../js/core/candles.js";
import { buildBackup, parseBackup, mergeAchievements, BackupError } from "../js/core/backup.js";
import { openStore, kv, destroyStore } from "../js/store.js";
import { setFetch } from "../js/sources/http.js";
import { createTwelve } from "../js/sources/twelve.js";
import { createFinnhub } from "../js/sources/stocks.js";
import { fxInst } from "../js/sources/fx.js";
import { newBot, byRank, step as botStep, freshQuotes, standing, botName, STYLE_IDS, MAX_AGE, preview as botPreview } from "../js/core/bots.js";
import * as C from "../js/core/cheats.js";
import * as RP from "../js/core/replay.js";
import * as SW from "../js/sim/world.js";
import * as FUN from "../js/sim/fun.js";
import * as RICH from "../js/core/rich.js";
import * as F from "../js/ui/format.js";
import * as RW from "../js/sim/rewind.js";
import * as CLEAN from "../js/core/sanitize.js";
import { cheatTick, BOT_CHEATS, NEVER, validBots } from "../js/core/bots.js";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e?.message || String(e)]); }
}
function ok(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }
function near(a, b, msg, rel = 1e-9) { if (!(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)))) throw new Error(`${msg}: expected ${b}, got ${a}`); }
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
function deepEq(a, b, msg) { if (canon(a) !== canon(b)) throw new Error(msg + ": not equal"); }

const MEME = { key: "meme:GHST", m: "meme", id: "GHST", sym: "GHOST", name: "Ghost Coin", pair: "POOL1" };
const BTC = { key: "crypto:BTCUSDT", m: "crypto", id: "BTCUSDT", sym: "BTC", name: "Bitcoin" };
const AAPL = { key: "stock:AAPL", m: "stock", id: "AAPL", sym: "AAPL", name: "Apple" };
const EURUSD = fxInst("EURUSD"), USDJPY = fxInst("USDJPY");
const ALWAYS = { open: true, since: 0 };
const T0 = Date.UTC(2026, 10, 24, 15, 0); // Tue 24 Nov 2026, 10:00 New York

// ---------------------------------------------------------------- 1. buy and sell in every market
await test("1 · Memecoin: 1% fee + liquidity price impact, buy and sell", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, MEME, 1000, { px: 0.001, liq: 100000, t: T0 }, T0);
  near(b.fee, 10, "buy fee");
  near(b.px, 0.00102, "effective price with 2% impact");
  near(b.qty, 970588.2352941176, "quantity");
  near(s.cash, 99000, "cash ($100,000 start − $1,000)");
  const v = E.executeSell(s, MEME.key, 1, { px: 0.0012, liq: 100000, t: T0 + 1 }, T0 + 1);
  near(v.fee, 11.375750865051902, "sell fee", 1e-9);
  near(v.usd, 1126.1993356401383, "cash received", 1e-9);
  near(v.pl, 126.19933564013832, "profit", 1e-9);
  near(s.cash, 100126.19933564014, "final cash", 1e-9);
  ok(!s.pos[MEME.key], "position closed");
});

await test("1 · Crypto: 0.1% fee + 0.02% slippage", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  near(b.fee, 1, "buy fee"); near(b.px, 60012, "effective price"); near(b.qty, 0.016646670665866826, "quantity");
  const v = E.executeSell(s, BTC.key, 1, { px: 66000, t: T0 }, T0);
  near(v.px, 65986.8, "effective sell price"); near(v.fee, 1.0984605278944213, "sell fee", 1e-9);
  near(v.usd, 1097.3620673665266, "received", 1e-9); near(v.pl, 97.36206736652662, "profit", 1e-9);
});

await test("1 · Stocks: $0 commission, you pay half the spread", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  eq(b.fee, 0, "commission"); near(b.px, 200.01, "effective price"); near(b.qty, 4.9997500124993755, "quantity (fractional)");
  const v = E.executeSell(s, AAPL.key, 1, { px: 210, t: T0 }, T0);
  near(v.px, 209.9895, "effective sell price"); near(v.usd, 1049.8950052497376, "received", 1e-9); near(v.pl, 49.89500524973755, "profit", 1e-9);
  near(quoteBuy(AAPL, 100, { px: 5 }).eff, 5.005, "cheap stock: $0.01 minimum spread");
});

await test("1 · Forex EURUSD: typical 1-pip spread", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, EURUSD, 1000, { px: 1.1, quoteUsd: 1, t: T0 }, T0);
  near(b.px, 1.10005, "effective price"); near(b.qty, 909.049588655061, "euros bought", 1e-9);
  const v = E.executeSell(s, EURUSD.key, 1, { px: 1.12, quoteUsd: 1, t: T0 }, T0);
  near(v.usd, 1018.0900868142356, "received", 1e-9); near(v.pl, 18.090086814235633, "profit", 1e-9);
});

await test("1 · Forex USDJPY: profit in yen converted to dollars", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, USDJPY, 1000, { px: 150, quoteUsd: 1 / 150, t: T0 }, T0);
  near(b.px, 150.005, "effective price"); near(b.qty, 999.9666677777408, "dollars in the position", 1e-9);
  const v = E.executeSell(s, USDJPY.key, 1, { px: 155, quoteUsd: 1 / 155, t: T0 }, T0);
  near(v.usd, 1032.1924753045867, "received", 1e-9); near(v.pl, 32.19247530458665, "profit", 1e-9);
});

await test("1 · Partial sell, buying without cash and portfolio value", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 2000, { px: 50000, t: T0 }, T0);
  const v = E.executeSell(s, BTC.key, 0.5, { px: 50000, t: T0 }, T0);
  near(v.cost, 1000, "cost of half");
  ok(s.pos[BTC.key] && Math.abs(s.pos[BTC.key].cost - 1000) < 1e-9, "the other half remains");
  let threw = false;
  try { E.executeBuy(s, BTC, 1e6, { px: 50000, t: T0 }, T0); } catch (e) { threw = e instanceof E.TradeError; }
  ok(threw, "can't buy more than the cash");
  const t = E.totals(s, () => ({ px: 50000 }));
  near(t.total, s.cash + s.pos[BTC.key].qty * 50000, "total = cash + positions");
});

// ---------------------------------------------------------------- 2. stocks wait for the open
const SAT = H.nyToUtc(2026, 11, 28, 12, 0);         // Saturday
const FRI_CLOSE_T = H.nyToUtc(2026, 11, 27, 12, 59); // last trade Friday (early close day)
const MON_OPEN = H.nyToUtc(2026, 11, 30, 9, 30);

await test("2 · Hours: 9:30 AM–4:00 PM NY, holidays and early close", () => {
  const mon = H.stockStatus(Date.UTC(2026, 10, 23, 22, 11)); // Mon 17:11 NY
  ok(!mon.open && mon.reason === "post", "Monday 5:11 PM closed");
  eq(mon.nextOpen, Date.UTC(2026, 10, 24, 14, 30), "opens Tuesday 9:30 AM NY (14:30 UTC)");
  const tg = H.stockStatus(H.nyToUtc(2026, 11, 26, 11, 0));
  ok(!tg.open && tg.reason === "holiday", "Thanksgiving closed");
  eq(tg.nextOpen, H.nyToUtc(2026, 11, 27, 9, 30), "opens Friday");
  const fri = H.stockStatus(H.nyToUtc(2026, 11, 27, 12, 0));
  ok(fri.open && fri.early, "Friday open with early close");
  eq(fri.closesAt, H.nyToUtc(2026, 11, 27, 13, 0), "closes at 1:00 PM");
  ok(!H.stockStatus(H.nyToUtc(2026, 11, 27, 13, 30)).open, "1:30 PM already closed");
  eq(H.nyToUtc(2026, 3, 9, 9, 30), Date.UTC(2026, 2, 9, 13, 30), "daylight saving time: 9:30 AM NY = 13:30 UTC");
  ok(H.stockStatus(H.nyToUtc(2026, 11, 24, 9, 30)).open && !H.stockStatus(H.nyToUtc(2026, 11, 24, 9, 29)).open, "opens exactly at 9:30 AM");
});

await test("2 · Forex: Sunday 5:00 PM to Friday 5:00 PM NY", () => {
  ok(H.fxStatus(H.nyToUtc(2026, 11, 27, 16, 59)).open, "Friday 4:59 PM open");
  const fc = H.fxStatus(H.nyToUtc(2026, 11, 27, 17, 0));
  ok(!fc.open, "Friday 5:00 PM closed");
  eq(fc.nextOpen, H.nyToUtc(2026, 11, 29, 17, 0), "opens Sunday 5:00 PM");
  ok(!H.fxStatus(H.nyToUtc(2026, 11, 29, 16, 59)).open && H.fxStatus(H.nyToUtc(2026, 11, 29, 17, 0)).open, "Sunday 5:00 PM opens");
  eq(H.fxStatus(H.nyToUtc(2026, 11, 24, 3, 0)).closesAt, H.nyToUtc(2026, 11, 27, 17, 0), "countdown to the Friday close");
});

await test("2 · Stocks: with the market closed the order waits and fills at the open", () => {
  const s = E.newPortfolio(SAT);
  const r = E.placeOrder(s, AAPL, { side: "buy", type: "market", amount: 1000 }, { px: 200, t: FRI_CLOSE_T }, SAT, H.marketStatus("stock", SAT));
  ok(r.order && !r.trade, "did not fill on Saturday");
  eq(s.cash, 100000, "cash did not move");
  eq(E.available(s), 99000, "but the amount is set aside");
  eq(E.checkKey(s, AAPL.key, { px: 195, t: SAT + 60e3 }, SAT + 60e3, H.marketStatus("stock", SAT + 60e3)).length, 0, "Saturday: still waiting");
  const at = MON_OPEN + 5000;
  eq(E.checkKey(s, AAPL.key, { px: 201, t: FRI_CLOSE_T }, at, H.marketStatus("stock", at)).length, 0, "Friday's old price does not fill it");
  const ev = E.checkKey(s, AAPL.key, { px: 202, t: MON_OPEN + 2000 }, at, H.marketStatus("stock", at));
  eq(ev.length, 1, "filled at the open"); eq(ev[0].type, "fill", "event"); eq(ev[0].trade.reason, "open", "reason");
  near(ev[0].trade.px, 202.0101, "at the first real price after the open (202 + half of the 0.0202 spread)");
  eq(s.orders.length, 0, "no orders left");
});

await test("2 · Selling stocks and forex outside hours also waits", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  E.executeBuy(s, EURUSD, 1000, { px: 1.1, quoteUsd: 1, t: T0 }, T0);
  E.placeOrder(s, AAPL, { side: "sell", type: "market", frac: 1 }, { px: 200, t: FRI_CLOSE_T }, SAT, H.marketStatus("stock", SAT));
  E.placeOrder(s, EURUSD, { side: "sell", type: "market", frac: 1 }, { px: 1.1, quoteUsd: 1, t: SAT }, SAT, H.marketStatus("fx", SAT));
  ok(s.pos[AAPL.key] && s.pos[EURUSD.key] && s.orders.length === 2, "both wait");
  const sun = H.nyToUtc(2026, 11, 29, 17, 0) + 30e3;
  const ev = E.checkKey(s, EURUSD.key, { px: 1.11, quoteUsd: 1, t: sun }, sun, H.marketStatus("fx", sun));
  ok(ev[0]?.type === "fill" && !s.pos[EURUSD.key], "forex sells at the Sunday open");
  ok(s.pos[AAPL.key], "the stock keeps waiting for Monday");
});

// ---------------------------------------------------------------- 3. limit, stop loss, take profit
await test("3 · Buy limit order: fills when the price touches it", () => {
  const s = E.newPortfolio(T0);
  const r = E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 1000, limit: 58000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  ok(r.order, "order placed");
  eq(E.checkKey(s, BTC.key, { px: 59000, t: T0 + 1 }, T0 + 1, ALWAYS).length, 0, "not at 59,000");
  const ev = E.checkKey(s, BTC.key, { px: 57990, t: T0 + 2 }, T0 + 2, ALWAYS);
  eq(ev[0]?.type, "fill", "yes at 57,990"); eq(ev[0].trade.reason, "limit", "reason");
  near(ev[0].trade.px, 57990 * 1.0002, "with the normal fee and slippage");
});

await test("3 · Opening the app after the price already passed fills the order", () => {
  let s = E.newPortfolio(T0);
  E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 1000, limit: 58000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  s = JSON.parse(JSON.stringify(s)); // closed and reopened: state comes back from storage
  const ev = E.checkKey(s, BTC.key, { px: 50000, t: T0 + 3600e3 }, T0 + 3600e3, ALWAYS);
  eq(ev[0]?.type, "fill", "fills at the current price"); near(ev[0].trade.mid, 50000, "at the current price (better than the limit)");
});

await test("3 · Partial sell limit order", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.placeOrder(s, BTC, { side: "sell", type: "limit", frac: 0.5, limit: 65000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  eq(E.checkKey(s, BTC.key, { px: 64000, t: T0 }, T0, ALWAYS).length, 0, "not at 64,000");
  const q0 = s.pos[BTC.key].qty;
  const ev = E.checkKey(s, BTC.key, { px: 65100, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "fill", "yes at 65,100"); near(s.pos[BTC.key].qty, q0 / 2, "sold half");
});

await test("3 · Stop loss and take profit, also when the price gaps", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.setStops(s, BTC.key, { sl: 55000, tp: 70000 });
  eq(E.checkKey(s, BTC.key, { px: 56000, t: T0 }, T0, ALWAYS).length, 0, "nothing at 56,000");
  const ev = E.checkKey(s, BTC.key, { px: 54000, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "sl", "stop loss triggered"); ok(ev[0].trade.pl < 0, "at a loss"); ok(!s.pos[BTC.key], "position closed");
  near(ev[0].trade.px, 54000 * (1 - 0.0002), "sells at the live price");
  const s2 = E.newPortfolio(T0);
  E.executeBuy(s2, MEME, 500, { px: 0.001, liq: 1e6, t: T0 }, T0);
  E.setStops(s2, MEME.key, { tp: 0.002 });
  const ev2 = E.checkKey(s2, MEME.key, { px: 0.0025, liq: 1e6, t: T0 }, T0, ALWAYS);
  eq(ev2[0]?.type, "tp", "take profit triggered"); ok(ev2[0].trade.pl > 0, "at a profit");
});

await test("3 · Stock stop loss: doesn't trigger while closed, does at the open", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  E.setStops(s, AAPL.key, { sl: 190 });
  eq(E.checkKey(s, AAPL.key, { px: 180, t: SAT }, SAT, H.marketStatus("stock", SAT)).length, 0, "Saturday: nothing");
  const at = MON_OPEN + 1000;
  const ev = E.checkKey(s, AAPL.key, { px: 180, t: MON_OPEN + 500 }, at, H.marketStatus("stock", at));
  eq(ev[0]?.type, "sl", "triggers at the Monday open");
});

await test("3 · An order there's no longer cash for is canceled with a notice", () => {
  const s = E.newPortfolio(T0);
  E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 10000, limit: 50000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  s.cash = 0; // e.g. after an import
  const ev = E.checkKey(s, BTC.key, { px: 49000, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "cancel", "canceled"); eq(s.orders.length, 0, "no orders");
});

// ---------------------------------------------------------------- 4. save, export, import
function sampleState() {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, MEME, 300, { px: 0.001, liq: 2e5, t: T0 }, T0);
  E.executeBuy(s, BTC, 2000, { px: 60000, t: T0 }, T0 + 1);
  E.executeBuy(s, AAPL, 1500, { px: 200, t: T0 }, T0 + 2);
  E.executeBuy(s, USDJPY, 800, { px: 150, quoteUsd: 1 / 150, t: T0 }, T0 + 3);
  E.executeSell(s, BTC.key, 0.5, { px: 63000, t: T0 }, T0 + 4);
  E.setStops(s, AAPL.key, { sl: 180, tp: 260 });
  E.placeOrder(s, EURUSD, { side: "buy", type: "limit", amount: 400, limit: 1.05 }, { px: 1.1, quoteUsd: 1, t: T0 }, T0 + 5, ALWAYS);
  E.recordDay(s, localDay(T0), 100012.5, T0);
  return s;
}

await test("4 · The portfolio is saved in IndexedDB and comes back the same", async () => {
  await destroyStore("ghost-desk-unittest");
  ok(await openStore("ghost-desk-unittest"), "IndexedDB available");
  const s = sampleState();
  await kv.set("portfolio", s);
  deepEq(await kv.get("portfolio"), s, "saved = read");
});

await test("4 · Export and import give the same portfolio (no keys in the file)", async () => {
  const s = sampleState();
  const a = newAchievements();
  evaluate(a, s.trades, { trades: s.trades, total: 100000, start: s.start, now: T0 });
  const settings = { finnhubKey: "FAKEKEY_FH_0123456789", twelveKey: "FAKEKEY_TD_abcdef0123", sound: true, alerts: [] };
  const text = buildBackup({ portfolio: s, achievements: a, settings });
  ok(!text.includes("FAKEKEY"), "the file has no keys");
  const d = parseBackup(text);
  deepEq(d.portfolio, s, "portfolio imported");
  deepEq(d.achievements, a, "achievements imported");
  eq(d.settings.sound, true, "public settings imported");
  await kv.set("portfolio", d.portfolio);
  deepEq(await kv.get("portfolio"), s, "imported, saved and read");
  const val = k => E.totals(k, key => ({ [BTC.key]: { px: 61000 }, [MEME.key]: { px: 0.0011, liq: 2e5 }, [AAPL.key]: { px: 205 }, [USDJPY.key]: { px: 151, quoteUsd: 1 / 151 } }[key])).total;
  near(val(d.portfolio), val(s), "same total value");
  let bad = false;
  try { parseBackup('{"app":"otra"}'); } catch (e) { bad = e instanceof BackupError; }
  ok(bad, "rejects files that aren't backups");
  const merged = mergeAchievements(newAchievements(), a);
  ok(merged.unlocked.first_trade === a.unlocked.first_trade, "achievements merge");
});

await test("4 · History to CSV, no dangerous formulas", () => {
  const s = sampleState();
  s.trades[0].name = "=HYPERLINK(\"x\")";
  const csv = toCSV(s.trades);
  const lines = csv.trim().split("\r\n");
  eq(lines.length, s.trades.length + 1, "one row per trade");
  ok(csv.startsWith("﻿"), "BOM so Excel reads UTF-8");
  ok(lines[0].startsWith("date,market,symbol,name,side") && lines[0].includes("pl_usd"), "English headers");
  ok(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} (AM|PM),/.test(lines[1]), "US date format: " + lines[1].slice(0, 24));
  eq(usDateTime(new Date(2026, 10, 24, 16, 5, 9).getTime()), "11/24/2026 4:05:09 PM", "afternoon");
  eq(usDateTime(new Date(2026, 0, 2, 0, 7, 0).getTime()), "1/2/2026 12:07:00 AM", "midnight is 12 AM");
  ok(csv.includes("'=HYPERLINK"), "name neutralized");
});

// ---------------------------------------------------------------- 5. keys never in code, repo or stored URLs
const memKV = () => { const m = new Map(); return { get: async k => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)) }; };
function mockFetch(handler) {
  const calls = [];
  setFetch(async (url, opts = {}) => {
    calls.push({ url: String(url), headers: { ...(opts.headers || {}) } });
    const [status, body] = handler(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

await test("5 · Twelve Data: the key goes in the header, never in the URL; candles are saved and not requested again", async () => {
  const KEY = "FAKEKEY_TD_0123456789abcdef";
  const bars = [{ datetime: "2026-11-24 14:00:00", open: "200", high: "201", low: "199", close: "200.5" }, { datetime: "2026-11-24 15:00:00", open: "200.5", high: "202", low: "200", close: "201.5" }];
  const calls = mockFetch(() => [200, { values: bars, status: "ok" }]);
  const budget = memKV(), cache = memKV();
  const td = createTwelve({ getKey: () => KEY, budgetStore: budget, cache });
  const now = Date.UTC(2026, 10, 24, 16, 10);
  const r = await td.series("AAPL", "1h", { now, lastActive: now });
  eq(r.bars.length, 2, "candles"); eq(r.bars[1].t, Date.UTC(2026, 10, 24, 15, 0), "time in UTC");
  eq(calls.length, 1, "one request");
  ok(!calls[0].url.includes(KEY), "the key is not in the URL");
  eq(calls[0].headers.Authorization, "apikey " + KEY, "it goes in the header");
  const r2 = await td.series("AAPL", "1h", { now: now + 30 * 60e3, lastActive: now + 30 * 60e3 });
  eq(r2.src, "cache", "second time comes from the phone"); eq(calls.length, 1, "without spending another request");
  // weekend: Friday's copy still covers the market, no request
  const sat = H.nyToUtc(2026, 11, 28, 12, 0);
  await cache.set("td:AAPL:1h", { bars: [{ t: H.nyToUtc(2026, 11, 27, 12, 0), o: 1, h: 1, l: 1, c: 1 }], fetchedAt: sat - 3600e3 });
  const r3 = await td.series("AAPL", "1h", { now: sat, lastActive: H.lastStockActivity(sat) });
  eq(r3.src, "cache", "weekend: not requested again"); eq(calls.length, 1, "no requests");
  eq((await td.status(now)).used, 1, "daily credit counter");
  setFetch(null);
});

await test("5 · Twelve Data: once the 800 a day run out it stops asking and says so", async () => {
  const calls = mockFetch(() => [200, { status: "error", code: 429, message: "You have run out of API credits for the day." }]);
  const td = createTwelve({ getKey: () => "FAKEKEY_TD_x1234567", budgetStore: memKV(), cache: memKV() });
  const now = Date.UTC(2026, 10, 24, 16, 0);
  let e1;
  try { await td.series("EUR/USD", "5m", { now, lastActive: now }); } catch (e) { e1 = e; }
  ok(e1?.kind === "limit" && e1.body === "day", "daily limit error");
  let e2;
  try { await td.series("EUR/USD", "1m", { now, lastActive: now }); } catch (e) { e2 = e; }
  ok(e2?.kind === "limit", "still no candles"); eq(calls.length, 1, "did not ask again");
  ok((await td.status(now)).exhausted, "marked as used up");
  ok(!(await td.status(now + 86400e3)).exhausted, "resets the next day");
  setFetch(null);
});

await test("5 · Finnhub: a rejected key gives a clear error that doesn't contain the key", async () => {
  const KEY = "FAKEKEY_FH_9876543210";
  mockFetch(() => [401, { error: "Invalid API key" }]);
  const seen = [];
  const fh = createFinnhub({ getKey: () => KEY, onError: e => seen.push(e) });
  let err;
  try { await fh.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "auth", "error kind");
  ok(!JSON.stringify({ m: err.message, b: err.body, s: err.source }).includes(KEY), "the error doesn't carry the key");
  eq(seen.length, 1, "the app gets the notice");
  mockFetch(() => [429, { error: "API limit reached" }]);
  try { await fh.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "limit", "request limit");
  const noKey = createFinnhub({ getKey: () => "" });
  try { await noKey.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "nokey", "no key");
  setFetch(null);
});

await test("5 · The service worker only caches app files and fonts, never price requests", async () => {
  const sw = await (await fetch("../sw.js", { cache: "no-store" })).text();
  ok(/url\.origin === self\.location\.origin/.test(sw), "only the app's own files");
  ok(/FONT_HOSTS = \["fonts\.googleapis\.com", "fonts\.gstatic\.com"\]/.test(sw), "plus the fonts");
  ok(!/finnhub|twelvedata/i.test(sw.replace(/\/\/.*$/gm, "")), "doesn't touch the price sources");
  const app = await (await fetch("../js/app.js", { cache: "no-store" })).text();
  ok(!/localStorage|sessionStorage/.test(app), "keys don't go to localStorage");
});

// ---------------------------------------------------------------- starting balance (changed requirement: $100,000, choosable on reset)
await test("Start · $100,000 by default; reset can pick $10,000, $1,000,000 or a custom amount", () => {
  eq(START_CASH, 100000, "default starting balance");
  const d = E.newPortfolio(T0);
  eq(d.start, 100000, "start"); eq(d.cash, 100000, "cash");
  deepEq(START_CHOICES, [10000, 100000, 1000000], "the three choices");
  for (const n of [10000, 1000000, 25000, 123456.78]) {
    const s = E.newPortfolio(T0, n);
    eq(s.start, n, "start " + n); eq(s.cash, n, "cash " + n);
    near(E.totals(s, () => null).plPct, 0, "P&L starts at 0%");
  }
  for (const bad of [0, -5, 50, NaN, Infinity, 2e9, "100000"]) {
    let threw = false;
    try { E.newPortfolio(T0, bad); } catch (e) { threw = e instanceof E.TradeError; }
    ok(threw, "rejects " + String(bad));
  }
  const s = E.newPortfolio(T0, 1000000);
  E.executeBuy(s, BTC, 250000, { px: 60000, t: T0 }, T0);
  near(s.cash, 750000, "a $250,000 buy fits in $1,000,000");
  const t = E.totals(s, () => ({ px: 66000 }));
  near(t.pl, t.total - 1000000, "P&L is measured from the chosen start");
  let msg = "";
  try { E.executeBuy(E.newPortfolio(T0, 10000), BTC, 20000, { px: 60000, t: T0 }, T0); } catch (e) { msg = e.message; }
  eq(msg, "Not enough cash: you have $10,000.00 available.", "error message in English, US format");
});

await test("Start · costs are per trade, so the same trade costs the same with any starting balance", () => {
  for (const [inst, q] of [[MEME, { px: 0.001, liq: 100000 }], [BTC, { px: 60000 }], [AAPL, { px: 200 }], [EURUSD, { px: 1.1, quoteUsd: 1 }]]) {
    const a = E.executeBuy(E.newPortfolio(T0, 10000), inst, 1000, { ...q, t: T0 }, T0);
    const b = E.executeBuy(E.newPortfolio(T0, 1000000), inst, 1000, { ...q, t: T0 }, T0);
    eq(a.fee, b.fee, inst.sym + " fee"); eq(a.slip, b.slip, inst.sym + " slippage/spread"); eq(a.qty, b.qty, inst.sym + " quantity");
  }
  // bigger tickets on a thin memecoin pay more price impact (2× the size of the trade vs half the pool)
  const big = E.executeBuy(E.newPortfolio(T0, 1000000), MEME, 20000, { px: 0.001, liq: 100000, t: T0 }, T0);
  near(big.px, 0.00140, "a $20,000 buy into $100,000 of liquidity moves the price 40%");
});

await test("Start · money achievements scale with the starting balance", () => {
  const ids = ACHIEVEMENTS.map(a => a.id);
  ok(ids.includes("profit_10") && ids.includes("value_150") && !ids.includes("value_15k"), "relative goals replace the fixed $ ones");
  const run = (start, sellPx) => {
    const s = E.newPortfolio(T0, start), a = newAchievements();
    E.executeBuy(s, AAPL, start / 2, { px: 100, t: T0 }, T0);
    E.executeSell(s, AAPL.key, 1, { px: sellPx, t: T0 }, T0);
    return evaluate(a, s.trades, { trades: s.trades, total: E.totals(s, () => null).total, start, now: T0 });
  };
  // half the balance in AAPL at $100, sold at $125: realized ≈ +12.5% of the start → profit_10, total ≈ 1.125× → not value_150
  for (const start of [10000, 100000, 1000000]) {
    const got = run(start, 125);
    ok(got.includes("profit_10"), "profit_10 at " + start); ok(!got.includes("value_150"), "no value_150 at " + start);
  }
  ok(!run(100000, 115).includes("profit_10"), "+7.5% is not enough");
  ok(run(100000, 201).includes("value_150"), "doubling half the balance reaches 1.5×");
  ok(!evaluate(newAchievements(), [], { trades: [], total: 15000, start: 100000, now: T0 }).includes("value_150"), "$15,000 is no longer a goal on $100,000");
});

// ---------------------------------------------------------------- rival bots
const statusAt = now => m => H.marketStatus(m, now);
const L = (inst, px, t, extra = {}) => ({ inst, px, t, ...extra });
const MEMEX = { key: "meme:PUMP", m: "meme", id: "PUMP", sym: "PUMP", name: "Pump", pair: "POOL2" };

await test("Bots · own portfolio as big as mine and separate from mine", () => {
  const me = E.newPortfolio(T0, 250000);
  const b = newBot("momentum", { id: "b1", start: me.start, now: T0, seed: 1 });
  eq(b.pf.start, 250000, "same starting balance"); eq(b.pf.cash, 250000, "own cash");
  ok(b.pf !== me && b.pf.trades !== me.trades, "separate objects");
  const tr = botStep(b, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: T0 - 60e3 });
  eq(tr.length, 1, "the bot bought"); eq(me.cash, 250000, "my cash untouched"); eq(me.trades.length, 0, "my history untouched");
  deepEq(STYLE_IDS, ["momentum", "contrarian", "degen", "random"], "four styles");
  eq(botName("momentum", [b]), "Momentum 2", "several bots of one style get numbered");
});

await test("Bots · Momentum picks the fastest riser in the 4 markets, with my costs and my hours", () => {
  const entries = [L(BTC, 60000, T0, { ch24: 5 }), L(AAPL, 200, T0, { ch24: 4 }), L(EURUSD, 1.1, T0, { ch24: 0.2, quoteUsd: 1 }), L(MEMEX, 0.001, T0, { ch24: 300, ch1h: 20, liq: 50000 })];
  const b = newBot("momentum", { id: "m", start: 100000, now: T0, seed: 1 });
  const [t] = botStep(b, { entries, now: T0, status: statusAt(T0), bootAt: 0 });
  eq(t?.sym, "AAPL", "AAPL +4% beats BTC +5% (stocks move half as much); EURUSD +0.2% too small; thin memecoin skipped");
  near(t.usd, 6000, "6% of its $100,000");
  const mine = E.executeBuy(E.newPortfolio(T0), AAPL, 6000, { px: 200, t: T0 }, T0);
  eq(t.px, mine.px, "same effective price as my trade"); eq(t.fee, mine.fee, "same commission"); eq(t.slip, mine.slip, "same spread");
  eq(botStep(b, { entries, now: T0 + 30e3, status: statusAt(T0 + 30e3), bootAt: 0 }).length, 0, "waits its cooldown before the next buy");
  const sat = H.nyToUtc(2026, 11, 28, 12, 0);
  const b2 = newBot("momentum", { id: "m2", start: 100000, now: sat, seed: 1 });
  const [t2] = botStep(b2, { entries: entries.map(x => ({ ...x, t: sat })), now: sat, status: statusAt(sat), bootAt: 0 });
  eq(t2?.sym, "BTC", "Saturday: stocks and forex closed, so it buys crypto");
});

await test("Bots · no made-up trades for the time the app was closed", () => {
  const boot = T0;
  const b = newBot("momentum", { id: "x", start: 100000, now: T0 - 86400e3, seed: 1 });
  E.executeBuy(b.pf, BTC, 6000, { px: 60000, t: T0 - 86400e3 }, T0 - 86400e3);
  const before = JSON.stringify(b.pf);
  // prices from before the app opened (e.g. the last price saved yesterday) are not used, even if they would trigger a sale
  eq(botStep(b, { entries: [L(BTC, 40000, boot - 1000, { ch24: -30 }), L(AAPL, 200, boot - 1000, { ch24: 9 })], now: boot + 1000, status: statusAt(boot + 1000), bootAt: boot }).length, 0, "nothing with pre-open prices");
  eq(JSON.stringify(b.pf), before, "portfolio untouched");
  eq(freshQuotes([L(BTC, 60000, boot + 1000)], boot + 1000 + MAX_AGE + 1, statusAt(boot), boot).size, 0, "a price older than 10 min is not live");
  const mon = H.nyToUtc(2026, 11, 30, 9, 31);
  eq(freshQuotes([L(AAPL, 200, H.nyToUtc(2026, 11, 27, 12, 59))], mon, statusAt(mon), 0).size, 0, "Friday's stock price is not used after Monday's open");
  eq(freshQuotes([L(AAPL, 200, mon - 1000)], mon, statusAt(mon), 0).size, 1, "a price from after the bell is");
  const [s] = botStep(b, { entries: [L(BTC, 40000, boot + 2000, { ch24: -30 })], now: boot + 3000, status: statusAt(boot + 3000), bootAt: boot });
  eq(s?.side, "sell", "once a live price arrives it acts on it"); near(s.mid, 40000, "at that live price");
});

await test("Bots · exits: take profit, stop loss, faded momentum; Contrarian buys the drop", () => {
  const b = newBot("momentum", { id: "e", start: 100000, now: T0, seed: 1 });
  botStep(b, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  const up = botStep(b, { entries: [L(BTC, 64200, T0 + 60e3, { ch24: 7 })], now: T0 + 60e3, status: statusAt(T0), bootAt: 0 });
  ok(up[0]?.side === "sell" && up[0].pl > 0 && /take profit/.test(up[0].why), "+6.7% after costs → take profit");
  const b2 = newBot("momentum", { id: "e2", start: 100000, now: T0, seed: 1 });
  botStep(b2, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  const dn = botStep(b2, { entries: [L(BTC, 57500, T0 + 60e3, { ch24: 1 })], now: T0 + 60e3, status: statusAt(T0), bootAt: 0 });
  ok(dn[0]?.side === "sell" && dn[0].pl < 0 && /stop loss/.test(dn[0].why), "−4.2% → stop loss");
  const b3 = newBot("momentum", { id: "e3", start: 100000, now: T0, seed: 1 });
  botStep(b3, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  const fd = botStep(b3, { entries: [L(BTC, 60500, T0 + 60e3, { ch24: -0.5 })], now: T0 + 60e3, status: statusAt(T0), bootAt: 0 });
  ok(fd[0]?.side === "sell" && /faded/.test(fd[0].why), "24h turned negative → sells");
  const c = newBot("contrarian", { id: "c", start: 100000, now: T0, seed: 1 });
  const [ct] = botStep(c, { entries: [L(BTC, 60000, T0, { ch24: -6 }), L(AAPL, 200, T0, { ch24: -2.5 }), L(EURUSD, 1.1, T0, { ch24: -0.3, quoteUsd: 1 })], now: T0, status: statusAt(T0), bootAt: 0 });
  eq(ct?.sym, "BTC", "−6% crypto (score 6) beats −2.5% stock (score 5); −0.3% forex is too small");
});

await test("Bots · Degen: memecoins only, big bets capped by the pool's liquidity", () => {
  const d = newBot("degen", { id: "d", start: 100000, now: T0, seed: 1 });
  const NEWC = { ...MEMEX, key: "meme:NEW", id: "NEW", sym: "NEW", born: T0 - 5 * 60e3 };
  const entries = [L(BTC, 60000, T0, { ch24: 20 }), L(MEMEX, 0.001, T0, { ch24: 80, ch1h: 25, liq: 1e6 }), L(NEWC, 0.0002, T0, { ch24: 0, ch1h: 3, liq: 400000 }), L({ ...MEMEX, key: "meme:THIN", id: "THIN", sym: "THIN", born: T0 - 60e3 }, 0.01, T0, { liq: 5000 })];
  const [t] = botStep(d, { entries, now: T0, status: statusAt(T0), bootAt: 0 });
  eq(t?.sym, "NEW", "a 5-minute-old coin beats a pump; BTC and a $5K pool are ignored");
  near(t.usd, 10000, "min(25% of $100,000, 2.5% of $400,000 liquidity)");
  near(t.px, 0.0002 * 1.05, "pays the same 5% price impact I would");
  near(t.fee, 100, "and the same 1% fee");
  const [t2] = botStep(d, { entries, now: T0 + 61e3, status: statusAt(T0), bootAt: 0 });
  eq(t2?.sym, "PUMP", "next bet: the pumping coin");
  ok(t2.usd > 24000 && t2.usd <= 25000, "about 25% of its value: " + t2.usd);
});

await test("Bots · Random: reproducible from its seed, sizes 2–10%, trades only open markets", () => {
  const run = () => {
    const r = newBot("random", { id: "r", start: 100000, now: T0, seed: 12345 });
    const out = [];
    const sat = H.nyToUtc(2026, 11, 28, 12, 0);
    for (let i = 0; i < 60; i++) {
      const now = sat + i * 60e3;
      for (const t of botStep(r, { entries: [L(BTC, 60000 + i * 10, now, { ch24: 1 }), L(AAPL, 200, now, { ch24: 1 }), L(EURUSD, 1.1, now, { ch24: 0, quoteUsd: 1 })], now, status: statusAt(now), bootAt: 0 })) out.push(t);
    }
    return out;
  };
  const a = run(), b = run();
  ok(a.length > 3, "it trades (" + a.length + " trades in an hour)");
  deepEq(a.map(t => [t.side, t.sym, t.usd]), b.map(t => [t.side, t.sym, t.usd]), "same seed, same decisions");
  ok(a.every(t => t.sym === "BTC"), "Saturday: only crypto, stocks and forex are closed");
  ok(a.filter(t => t.side === "buy").every(t => t.usd >= 1900 && t.usd <= 10500), "sizes between 2% and 10% of its value");
});

await test("Bots · leaderboard numbers and backup round-trip", () => {
  const b = newBot("momentum", { id: "lb", start: 100000, now: T0, seed: 1 });
  E.executeBuy(b.pf, BTC, 1000, { px: 60000, t: T0 }, T0); E.executeSell(b.pf, BTC.key, 1, { px: 66000, t: T0 }, T0);
  E.executeBuy(b.pf, AAPL, 1000, { px: 200, t: T0 }, T0); E.executeSell(b.pf, AAPL.key, 1, { px: 190, t: T0 }, T0);
  const x = standing(b.pf, () => null);
  near(x.total, b.pf.cash, "total = cash with no positions"); near(x.plPct, (b.pf.cash - 100000) / 100000, "gain %");
  eq(x.best.sym, "BTC", "best trade"); eq(x.worst.sym, "AAPL", "worst trade"); eq(x.closed, 2, "closed trades");
  const text = buildBackup({ portfolio: E.newPortfolio(T0), achievements: newAchievements(), settings: {}, bots: [b] });
  deepEq(parseBackup(text).bots, [b], "bots come back from the file");
  const old = JSON.parse(text); delete old.bots;
  eq(parseBackup(JSON.stringify(old)).bots, null, "an older backup without bots leaves this phone's bots alone");
});

// ---------------------------------------------------------------- cheats
const cheated = () => { const s = E.newPortfolio(T0); s.undoable = true; return s; };

await test("Cheats · a clean portfolio has no star; any cheat marks it; a reset clears it", () => {
  const s = cheated();
  ok(!E.isCheated(s), "clean at start");
  C.setToggle(s, "zeroFees", true, T0);
  ok(E.isCheated(s), "turning a cheat on marks it"); eq(s.cheats.since, T0, "since when");
  C.setToggle(s, "zeroFees", false, T0 + 1);
  ok(E.isCheated(s), "turning it off doesn't remove the mark");
  ok(!E.isCheated(E.newPortfolio(T0 + 2)), "a reset portfolio is clean");
  eq(C.CHEATS.length, 25, "25 cheats in the menu (Oracle included)");
});

await test("Cheats · Zero fees and Market maker", () => {
  const s = cheated();
  C.setToggle(s, "zeroFees", true, T0);
  const b = E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  eq(b.fee, 0, "no commission"); eq(b.px, 60000, "no slippage"); near(b.qty, 1000 / 60000, "all $1,000 buys BTC");
  ok(b.cheat.includes("Zero fees"), "the trade carries the cheat");
  const m = cheated();
  C.setToggle(m, "marketMaker", true, T0);
  const t = E.executeBuy(m, MEME, 1000, { px: 0.001, liq: 100000, t: T0 }, T0);
  near(t.fee, 10, "the 1% commission stays"); eq(t.px, 0.001, "no price impact"); near(t.qty, 990000, "$990 at $0.001");
});

await test("Cheats · Leverage: 10x long, real liquidation when the loss reaches the margin", () => {
  const s = cheated();
  C.setLeverage(s, 10, T0);
  const o = E.openMargin(s, BTC, 1000, 10, 1, { px: 60000, t: T0 }, T0);
  near(o.size, 10000, "$1,000 margin controls $10,000"); near(o.fee, 10, "0.1% on the full size"); near(o.px, 60012, "0.02% slippage");
  near(s.cash, 99000, "the margin leaves cash");
  const p = E.marginPositions(s)[0];
  near(E.liqPrice(p), 54072, "equity 0 at 60,012 − 990 / (1/6 BTC)", 1e-9);
  eq(E.checkKey(s, BTC.key, { px: 54100, t: T0 + 1 }, T0 + 1, ALWAYS).length, 0, "still alive just above it");
  const [ev] = E.checkKey(s, BTC.key, { px: 54000, t: T0 + 2 }, T0 + 2, ALWAYS);
  eq(ev?.type, "liq", "liquidated"); near(ev.trade.pl, -1000, "loses exactly the margin"); near(s.cash, 99000, "nothing comes back");
  eq(E.marginPositions(s).length, 0, "position gone");
  ok(ev.trade.cheat.includes("Leverage 10x"), "the trade carries the cheat");
});

await test("Cheats · Short: 10x short BTC; Short anything opens memecoins", () => {
  const s = cheated();
  C.setLeverage(s, 10, T0);
  ok(C.canShort(s, BTC) && !C.canShort(s, MEME), "leverage shorts crypto/stocks/forex, not memecoins");
  const o = E.openMargin(s, BTC, 1000, 10, -1, { px: 60000, t: T0 }, T0);
  near(o.px, 59988, "short fills 0.02% under");
  const c = E.closeMargin(s, o.pos, 1, { px: 57000, t: T0 + 1 }, T0 + 1);
  // 990 + (59,988 − 57,011.4) × 1/6 − 9.5 fee on $9,500
  near(c.usd, 990 + (59988 - 57011.4) / 6 - 9.5, "paid back", 1e-9);
  near(c.pl, c.usd - 1000, "profit on the drop");
  C.setToggle(s, "shortAll", true, T0); C.setLeverage(s, 1, T0);
  ok(C.canShort(s, MEME), "Short anything: memecoins too");
  const m = E.openMargin(s, MEME, 100, 1, -1, { px: 0.001, liq: 1e6, t: T0 }, T0);
  ok(m.cheat.includes("Short anything"), "1x memecoin short is the Short anything cheat");
});

await test("Cheats · Diamond hands, Second chance", () => {
  const d = cheated();
  C.setToggle(d, "diamond", true, T0);
  const o = E.openMargin(d, BTC, 1000, 10, 1, { px: 60000, t: T0 }, T0);
  eq(E.checkKey(d, BTC.key, { px: 54000, t: T0 + 1 }, T0 + 1, ALWAYS).length, 0, "not liquidated");
  const c = E.closeMargin(d, o.pos, 1, { px: 54000, t: T0 + 2 }, T0 + 2);
  near(c.usd, 990 + (53989.2 - 60012) / 6 - 9, "the loss past the margin comes out of cash", 1e-9);
  ok(c.usd < 0, "negative proceeds");
  const s = cheated();
  C.setToggle(s, "secondChance", true, T0);
  E.openMargin(s, BTC, 1000, 10, 1, { px: 60000, t: T0 }, T0);
  const [ev] = E.checkKey(s, BTC.key, { px: 54000, t: T0 + 1 }, T0 + 1, ALWAYS);
  eq(ev?.type, "saved", "saved once"); const p = E.marginPositions(s)[0];
  eq(p.avg, 54000, "from the current price"); eq(p.cost, 1000, "with its margin"); near(p.qty, 10000 / 54000, "same 10x size");
  const [ev2] = E.checkKey(s, BTC.key, { px: 48000, t: T0 + 2 }, T0 + 2, ALWAYS);
  eq(ev2?.type, "liq", "the second liquidation that day is real");
  E.openMargin(s, BTC, 1000, 10, 1, { px: 60000, t: T0 + 86400e3 }, T0 + 86400e3);
  eq(E.checkKey(s, BTC.key, { px: 54000, t: T0 + 86401e3 }, T0 + 86401e3, ALWAYS)[0]?.type, "saved", "next day it works again");
});

await test("Cheats · Undo the last trade; printed money survives the undo", () => {
  const s = cheated();
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.executeBuy(s, AAPL, 500, { px: 200, t: T0 }, T0);
  C.printMoney(s, 10000, T0 + 1);
  const gone = C.undo(s, T0 + 2);
  eq(gone.length, 1, "one trade undone"); eq(gone[0].sym, "AAPL", "the last one");
  near(s.cash, 100000 - 1000 + 10000, "cash before the AAPL buy, plus the printed $10,000");
  ok(!s.pos[AAPL.key] && s.pos[BTC.key], "AAPL gone, BTC still there");
  eq(s.trades.length, 1, "history without the AAPL buy");
  let threw = false; try { C.undo(s, T0 + 3); } catch { threw = true; }
  ok(threw, "one step only");
});

await test("Cheats · 2x Lucky trade, Insurance, Rug shield", () => {
  const plain = E.newPortfolio(T0);
  E.executeBuy(plain, BTC, 1000, { px: 60000, t: T0 }, T0);
  const win = E.executeSell(plain, BTC.key, 1, { px: 66000, t: T0 }, T0);
  near(win.pl, 97.36206736652662, "plain profit (same as test 1)", 1e-9);
  const s = cheated();
  C.arm(s, "lucky", true, T0);
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  const l = E.executeSell(s, BTC.key, 1, { px: 66000, t: T0 }, T0);
  near(l.pl, 2 * 97.36206736652662, "profit doubled", 1e-9); ok(!C.isArmed(s, "lucky"), "used up");
  const i = cheated();
  C.arm(i, "insurance", true, T0);
  E.executeBuy(i, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.executeBuy(plain, BTC, 1000, { px: 60000, t: T0 }, T0);
  const lossPlain = E.executeSell(plain, BTC.key, 1, { px: 54000, t: T0 }, T0).pl;
  near(E.executeSell(i, BTC.key, 1, { px: 54000, t: T0 }, T0).pl, lossPlain / 2, "half the loss comes back", 1e-9);
  const r = cheated();
  C.setToggle(r, "rugShield", true, T0);
  E.executeBuy(r, MEME, 1000, { px: 0.001, liq: 1e9, t: T0 }, T0);
  const v = E.positionView(r.pos[MEME.key], { px: 0.0001, liq: 1e9 }, r);
  near(v.value, 800, "worth at least 80% of its cost after a −90% rug");
  near(E.executeSell(r, MEME.key, 1, { px: 0.0001, liq: 1e9, t: T0 }, T0).usd, 800, "and sells for that");
});

await test("Cheats · Ghost trade erases a losing position; Double or nothing flips the last win", () => {
  const s = cheated();
  C.arm(s, "ghost", true, T0);
  E.executeBuy(s, MEME, 1000, { px: 0.001, liq: 1e6, t: T0 }, T0);
  const t = E.executeSell(s, MEME.key, 1, { px: 0.0005, liq: 1e6, t: T0 + 1 }, T0 + 1);
  ok(t.ghosted > 0, "erased"); eq(s.trades.length, 0, "no trace in the history"); near(s.cash, 100000, "cash as if it never happened");
  E.executeBuy(s, MEME, 1000, { px: 0.001, liq: 1e6, t: T0 + 2 }, T0 + 2);
  ok(E.executeSell(s, MEME.key, 1, { px: 0.0005, liq: 1e6, t: T0 + 3 }, T0 + 3).pl < 0 && s.trades.length === 2, "only the next position");
  const d = cheated();
  E.executeBuy(d, BTC, 1000, { px: 60000, t: T0 }, T0);
  const w = E.executeSell(d, BTC.key, 1, { px: 66000, t: T0 }, T0);
  const cash = d.cash, gain = w.pl;
  const r = C.doubleOrNothing(d, 0.2, T0 + 1);
  ok(r.won, "heads"); near(d.cash, cash + gain, "the profit doubles"); near(w.pl, 2 * gain, "in the history too"); eq(w.flip, "won", "flipped");
  let threw = false; try { C.doubleOrNothing(d, 0.9, T0 + 2); } catch { threw = true; }
  ok(threw, "once per win");
  const e = cheated();
  E.executeBuy(e, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.executeBuy(e, AAPL, 5000, { px: 200, t: T0 }, T0);
  E.openMargin(e, BTC, 2000, 10, 1, { px: 66000, t: T0 }, T0);
  E.placeOrder(e, BTC, { side: "buy", type: "limit", amount: 100, limit: 1 }, { px: 66000, t: T0 }, T0, ALWAYS);
  eq(e.orders.length, 1, "an order waiting");
  E.executeSell(e, BTC.key, 1, { px: 66000, t: T0 }, T0);
  const lost = C.doubleOrNothing(e, 0.7, T0 + 1);
  ok(!lost.won, "tails");
  eq(e.cash, 100, "tails: the whole portfolio drops to $100");
  eq(Object.keys(e.pos).length + E.marginPositions(e).length + e.orders.length, 0, "no positions, leveraged positions or orders left");
  near(E.totals(e, () => ({ px: 66000, t: T0 })).total, 100, "worth exactly $100");
  ok(lost.before > 100000, "the confirmation knew what was at stake");
  ok(E.isCheated(e), "★");
});

await test("Cheats · Magic limit, Golden entry / Perfect exit / Sniper prices, Whale mode", () => {
  const s = cheated();
  E.placeOrder(s, AAPL, { side: "buy", type: "limit", amount: 1000, limit: 100 }, { px: 105, t: T0 }, T0, ALWAYS);
  eq(E.checkKey(s, AAPL.key, { px: 100.4, t: T0 + 1 }, T0 + 1, ALWAYS).length, 0, "without the cheat 0.4% away doesn't fill");
  C.setToggle(s, "magicLimit", true, T0 + 2);
  const [f] = E.checkKey(s, AAPL.key, { px: 100.4, t: T0 + 3 }, T0 + 3, ALWAYS);
  eq(f?.type, "fill", "within 0.5% fills"); eq(f.trade.mid, 100, "at the limit price"); ok(f.trade.cheat.includes("Magic limit"), "tagged");
  eq(E.checkKey(s, AAPL.key, { px: 1, t: T0 }, T0, ALWAYS).length, 0, "nothing else pending");
  const g = cheated();
  const b = E.executeBuy(g, BTC, 1000, { px: 60000, t: T0 }, T0, "manual", false, { price: 58000, tags: ["Golden entry"] });
  near(b.px, 58000 * 1.0002, "fills at the price the cheat found, with the normal costs"); ok(b.cheat.includes("Golden entry"), "tagged");
  const w = cheated();
  C.setToggle(w, "whale", true, T0);
  E.executeBuy(w, MEME, 10000, { px: 1, liq: 100000, t: T0 }, T0);
  near(E.whaleMult(w, MEME.key), 1.2, "a $10,000 buy in a $100,000 pool pushes it 20% in your game");
  const v = E.positionView(w.pos[MEME.key], { px: 1, liq: 100000 }, w);
  near(v.value, w.pos[MEME.key].qty * 1.2, "your position is valued at your game's price");
  near(E.positionView(w.pos[MEME.key], { px: 1, liq: 100000 }).value, w.pos[MEME.key].qty, "the real price is unchanged");
});

await test("Cheats · Moon boost, Airdrop once a day, Copycat; my cheats never apply to a bot", () => {
  const s = cheated();
  E.executeBuy(s, MEME, 1000, { px: 1, liq: 1e9, t: T0 }, T0);
  const qty1 = s.pos[MEME.key].qty;
  C.startBoost(s, MEME.key, 1, T0);
  E.checkKey(s, MEME.key, { px: 1.5, liq: 1e9, t: T0 + 60e3 }, T0 + 60e3, ALWAYS);
  near(E.positionView(s.pos[MEME.key], { px: 1.5 }, s).value, qty1 * 1.5 + 2 * qty1 * 0.5, "the +50% counts 3x");
  E.checkKey(s, MEME.key, { px: 2, liq: 1e9, t: T0 + 11 * 60e3 }, T0 + 11 * 60e3, ALWAYS); // after the 10 minutes
  const cash = s.cash;
  const r = C.settleBoost(s, T0 + 11 * 60e3);
  near(r.extra, 2 * qty1 * 0.5, "pays at the last price seen inside the 10 minutes"); near(s.cash, cash + r.extra, "to cash");
  const a = cheated();
  const t = C.airdrop(a, MEME, { px: 0.5, liq: 1e6, t: T0 }, T0);
  eq(t.usd, 0, "free"); near(t.qty, 2000, "$1,000 (1% of $100,000) worth at $0.50"); eq(a.pos[MEME.key].cost, 0, "cost 0");
  let threw = false; try { C.airdrop(a, MEME, { px: 0.5, t: T0 + 1 }, T0 + 1); } catch { threw = true; }
  ok(threw, "once a day");
  C.airdrop(a, BTC, { px: 50000, t: T0 + 86400e3 }, T0 + 86400e3);
  const bot = newBot("momentum", { id: "c", start: 100000, now: T0, seed: 1 });
  C.setToggle(a, "whale", true, T0); C.setToggle(a, "zeroFees", true, T0);
  const [bt] = botStep(bot, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  near(bt.fee, 6, "my Zero fees don't apply to the bot: it pays 0.1% on $6,000"); ok(!bot.pf.cheats && !bt.cheat, "the bot has no cheats of its own yet");
  const me = cheated();
  C.copycat(me, bot, T0 + 1);
  near(me.cash, bot.pf.cash, "same cash"); deepEq(Object.keys(me.pos), Object.keys(bot.pf.pos), "same positions");
  ok(me.pos[BTC.key] !== bot.pf.pos[BTC.key], "a copy: the bot's portfolio is untouched"); ok(E.isCheated(me), "marked");
});

await test("Cheats · X-ray shows the bot's next buy before it makes it", () => {
  const bot = newBot("random", { id: "x", start: 100000, now: T0, seed: 777 });
  const entries = [L(BTC, 60000, T0, { ch24: 1 }), L(AAPL, 200, T0, { ch24: 1 }), L(EURUSD, 1.1, T0, { ch24: 0, quoteUsd: 1 })];
  let seen = null, made = null;
  for (let i = 0; i < 30 && !made; i++) {
    const now = T0 + i * 60e3, args = { entries: entries.map(e => ({ ...e, t: now })), now, status: statusAt(now), bootAt: 0 };
    seen = botPreview(bot, args).buy;
    made = botStep(bot, args).find(t => t.side === "buy") || null;
    if (!made) ok(!seen, "no buy predicted when it doesn't buy");
  }
  ok(made, "it bought");
  eq(seen?.sym, made.sym, "X-ray saw the symbol"); near(seen.usd, made.usd, "and the amount");
});

await test("Cheats · achievements earned with cheats count the same", () => {
  const a = newAchievements();
  const s = cheated();
  C.printMoney(s, 1000000, T0);
  const got = evaluate(a, [], { trades: s.trades, total: E.totals(s).total, start: s.start, now: T0, cheated: E.isCheated(s) });
  ok(got.includes("value_150") && a.cheated.value_150, "+50% from the money printer is marked as with cheats");
  const clean = E.newPortfolio(T0);
  E.executeBuy(clean, BTC, 100, { px: 100, t: T0 }, T0);
  evaluate(a, clean.trades, { trades: clean.trades, total: 100000, start: 100000, now: T0 + 1, cheated: false });
  ok(a.unlocked.first_trade && !a.cheated.first_trade, "a clean one is not");
  evaluate(a, [], { trades: [], total: 160000, start: 100000, now: T0 + 2, cheated: false });
  ok(!a.cheated.value_150, "earned again without cheats: the mark goes away");
  eq(a.unlocked.value_150, T0, "and its date stays: it already counted");
  const csv = toCSV([...s.trades, { t: T0, m: "crypto", sym: "BTC", name: "Bitcoin", side: "buy", dir: -1, lev: 50, qty: 1, px: 1, usd: 1, cheat: ["Leverage 50x"], reason: "manual" }]);
  ok(/,short,/.test(csv) && /,50x,Leverage 50x/.test(csv), "CSV says short, 50x and the cheat");
});

await test("Cheats · Time machine: only the past, real candles, Peek and Time skip", () => {
  const now = T0;
  const days = RP.replayDays(now);
  ok(days.every(d => d.from < RP.startOfDay(now)), "only days before today");
  const day = days[0].from;
  const bars = []; for (let i = 0; i < 2000; i++) bars.push({ t: day + i * 60e3, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i });
  let threw = false; try { RP.newReplay({ inst: BTC, bars, day: RP.startOfDay(now), start: 100000, now }); } catch { threw = true; }
  ok(threw, "today is refused");
  const rp = RP.newReplay({ inst: BTC, bars, day, start: 100000, now });
  ok(E.isCheated(rp.pf), "the replay portfolio carries the star");
  eq(RP.priceNow(rp).px, 101.5, "price = close of the last finished minute");
  rp.playing = true; rp.speed = 60; RP.advance(rp, 1000);
  eq(RP.priceNow(rp).px, 102.5, "60x: one second of real time is one minute");
  rp.speed = 0.25; RP.advance(rp, 60e3);
  eq(RP.priceNow(rp).px, 102.5, "0.25x: a minute of real time is 15 seconds");
  deepEq(RP.peekBars(rp).map(b => b.c), [103.5, 104.5, 105.5, 106.5, 107.5], "Peek: the next 5 candles");
  const t = RP.buy(rp, 1000);
  near(t.mid, 102.5, "buys at the replay price"); ok(t.cheat.includes("Time machine"), "tagged");
  RP.skip(rp, 3600e3);
  near(RP.totals(rp).held, E.positionView(rp.pf.pos[BTC.key], { px: RP.priceNow(rp).px }).value, "+1 hour: positions at the price an hour later");
  RP.skip(rp, 86400e3); const end = RP.skip(rp, 86400e3);
  ok(end && rp.t === rp.end && rp.t <= day + 2000 * 60e3, "+1 day never goes past the last real candle");
  ok(RP.replayable(EURUSD) && RP.replayable(USDJPY) && !RP.replayable(fxInst("EURGBP")), "pairs with USD only");
});

// ---------------------------------------------------------------- Sim mode: invented markets (seeded, no network)
const ST0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const byM = (w, m) => Object.values(w.insts).filter(i => i.m === m);
const fresh = (seed = 7) => SW.createWorld(seed, ST0);

await test("Sim: the world has invented markets in all 4 types, with candles since each one exists, built fast", () => {
  const t = performance.now();
  const w = fresh();
  const ms = performance.now() - t;
  eq(byM(w, "crypto").length, 14, "crypto"); eq(byM(w, "stock").length, 14, "stocks"); eq(byM(w, "fx").length, 8, "forex pairs"); eq(byM(w, "meme").length, 22, "memecoins");
  ok(ms < 3000, `built in ${Math.round(ms)} ms`);
  for (const i of Object.values(w.insts)) {
    ok(i.px > 0 && isFinite(i.px), i.key + " price");
    ok(i.b1.length > 0, i.key + " 1m candles");
    for (const b of i.b1) ok(b[2] >= Math.max(b[1], b[4]) - 1e-15 && b[3] <= Math.min(b[1], b[4]) + 1e-15, i.key + " high/low");
  }
  const btcish = w.insts["crypto:NBL"];
  ok(btcish.bd.length >= 119 && btcish.bd[0][0] <= ST0 - 119 * SW.DAY, "120 days of daily candles for crypto");
  eq(btcish.b1.length, 360, "6 hours of 1-minute candles");
  for (const i of byM(w, "meme")) ok(i.b1[0][0] <= i.born + 60e3 || i.born < ST0 - 6 * SW.HOUR, i.sym + ": candles from its birth (" + new Date(i.born).toISOString() + ")");
  const young = byM(w, "meme").filter(i => i.born > ST0 - 6 * SW.HOUR);
  ok(young.length > 5, "several young coins");
  near(SW.priceAt(btcish, ST0), btcish.px, "priceAt now = last price");
});

await test("Sim: same seed, same market; a saved world continues exactly the same way", () => {
  const a = fresh(99), b = fresh(99), c = fresh(100);
  eq(a.insts["stock:ZTRX"].px, b.insts["stock:ZTRX"].px, "same seed same price");
  ok(a.insts["stock:ZTRX"].px !== c.insts["stock:ZTRX"].px, "another seed, another market");
  SW.step(a, ST0 + 20e3);
  const saved = JSON.parse(JSON.stringify(a)); // what IndexedDB keeps
  SW.step(a, ST0 + 50e3); SW.step(saved, ST0 + 50e3);
  eq(JSON.stringify(a.insts["crypto:QRK"].b1.slice(-2)), JSON.stringify(saved.insts["crypto:QRK"].b1.slice(-2)), "continues identically");
  eq(a.memes.join(), saved.memes.join(), "same new coins");
});

await test("Sim: prices move every second, new memecoins every few seconds, always open; a long gap is not fast-forwarded", () => {
  const w = fresh();
  const k = "crypto:SLC", px = [];
  const n0 = w.coinN;
  for (let s = 1; s <= 60; s++) { SW.step(w, ST0 + s * 1000); px.push(w.insts[k].px); }
  eq(new Set(px).size, 60, "60 different prices in 60 seconds");
  eq(w.t, ST0 + 60e3, "clock");
  const born = w.coinN - n0;
  ok(born >= 6 && born <= 16, `new coins in a minute: ${born}`);
  const last = byM(w, "meme").sort((a, b) => b.born - a.born)[0];
  ok(ST0 + 60e3 - last.born <= 10e3, "the newest coin is seconds old");
  SW.step(w, ST0 + 60e3 + 3600e3);
  eq(w.t, ST0 + 60e3 + 3600e3, "clock caught up");
  eq(w.insts[k].b1.filter(b => b[0] > ST0 + 60e3 && b[0] < ST0 + 3600e3).length, 0, "no candles invented for the hour the app was closed");
});

await test("Sim: memecoin fates: pump +1,000% in minutes (gold candles), moonshot 100x, rug to near zero", () => {
  const w = fresh(3);
  const [p, m, r] = byM(w, "meme").filter(i => !i.dead).slice(-3);
  const t = w.t;
  Object.assign(p.fate, { kind: "pump", pumpAt: t + 1000, pumpDur: 180, mult: 11, rugAt: null });
  Object.assign(m.fate, { kind: "moonshot", pumpAt: t + 1000, pumpDur: 400, mult: 100, rugAt: null });
  Object.assign(r.fate, { kind: "normal", pumpAt: 0, pumpDur: 0, mult: 0, rugAt: t + 5000 });
  p.pumping = m.pumping = false;
  const p0 = p.px, m0 = m.px, r0 = r.px, seen = [];
  for (let s = 1; s <= 401; s++) { const k = new Set([p.key, m.key, r.key]); seen.push(...SW.step(w, t + s * 1000, { keep: k })); }
  const xp = SW.priceAt(p, t + 181e3) / p0, xm = m.px / m0;
  ok(xp > 4 && xp < 40, `pump x${xp.toFixed(1)} in 3 minutes`);
  ok(xm > 25, `moonshot x${xm.toFixed(0)}`);
  ok(r.dead && r.px / r0 < 0.06, `rug: ${(100 * (1 - r.px / r0)).toFixed(1)}% down`);
  ok(SW.bars(p, "1m").some(b => b.g), "gold candles during the pump");
  ok(!SW.bars(r, "1m").slice(-3).some(b => b.g), "no gold on a rugged coin");
  for (const kind of ["pump", "moonshot", "rug"]) ok(seen.some(e => e.kind === kind), "event " + kind);
  // fates at birth over many coins: moonshots very rare, pumps uncommon, rugs common
  const cnt = { moonshot: 0, pump: 0, normal: 0, rug: 0 };
  const w2 = fresh(11);
  for (let s = 1; s <= 1800; s++) SW.step(w2, w2.t + 1000, { keep: new Set(Object.keys(w2.insts)) });
  for (const i of byM(w2, "meme")) { cnt[i.fate.kind]++; if (i.fate.rugAt) cnt.rug++; }
  const all = cnt.moonshot + cnt.pump + cnt.normal;
  ok(all > 200, "coins in 30 minutes: " + all);
  ok(cnt.moonshot / all < 0.05 && cnt.pump / all > 0.1 && cnt.pump / all < 0.35 && cnt.rug / all > 0.3, JSON.stringify(cnt));
});

await test("Sim: whales shake memecoins; stocks crash and rally; forex calm except news", () => {
  const w = fresh(5);
  const seen = {};
  const fx = w.insts["fx:ZVKUSD"], rets = [];
  for (let s = 1; s <= 1800; s++) {
    const before = fx.px;
    for (const e of SW.step(w, w.t + 1000)) { seen[e.kind] = (seen[e.kind] || 0) + 1; if (e.kind === "whale") ok(Math.abs(e.move) >= 0.2, "whale size"); }
    rets.push(Math.log(fx.px / before));
  }
  ok(seen.whale > 3, "whales: " + seen.whale);
  ok((seen.crash || 0) + (seen.rally || 0) > 3, `crashes ${seen.crash} rallies ${seen.rally}`);
  const calm = rets.filter(x => Math.abs(x) < 0.003);
  const sd = Math.sqrt(calm.reduce((a, x) => a + x * x, 0) / calm.length);
  ok(sd < 0.00005, "forex 1-second moves are tiny: " + sd);
  const st = w.insts["stock:NVMT"], cr = w.insts["crypto:VTX"];
  const vol = i => { const b = i.b1.slice(-60), r = []; for (let k = 1; k < b.length; k++) r.push(Math.abs(Math.log(b[k][4] / b[k - 1][4]))); r.sort((x, y) => x - y); return r[r.length >> 1]; }; // median: a news jump does not count
  ok(vol(cr) > vol(fx) * 5, "crypto moves much more than forex");
  ok(seen.coin > 150 && seen.gone > 0, `new coins ${seen.coin}, old ones pruned`);
  ok(byM(w, "meme").length <= SW.MAX_MEMES, "memecoins capped at " + SW.MAX_MEMES);
  void st;
});

await test("Sim: events move everything: Bull run up, Black swan down, Elon tweet explodes a memecoin, countdown is real", () => {
  const snapPx = w => Object.fromEntries(Object.values(w.insts).map(i => [i.key, i.px]));
  const avg = (w, m, px0) => { const xs = byM(w, m).filter(i => px0[i.key]).map(i => Math.log(i.px / px0[i.key])); return xs.reduce((a, x) => a + x, 0) / xs.length; };
  const w1 = fresh(21), w2 = fresh(21);
  const t = w1.t;
  const bull = SW.forceEvent(w1, "bull"), swan = SW.forceEvent(w2, "blackSwan");
  const s1 = snapPx(w1), s2 = snapPx(w2);
  eq(bull.title, "Bull run", "title"); eq(bull.until - bull.start, SW.EVENTS.bull.dur * 1000, "real duration");
  for (let s = 1; s <= 40; s++) { SW.step(w1, t + s * 1000); SW.step(w2, t + s * 1000); }
  ok(avg(w1, "crypto", s1) > 0.01, "bull: crypto up " + avg(w1, "crypto", s1));
  ok(avg(w2, "crypto", s2) < -0.03, "black swan: crypto down " + avg(w2, "crypto", s2));
  ok(avg(w2, "meme", s2) < avg(w1, "meme", s1), "memes too");
  const w3 = fresh(22);
  const ev = SW.forceEvent(w3, "elonTweet");
  const coin = w3.insts[ev.keys[0]];
  coin.fate.rugAt = null;
  const c0 = coin.px;
  for (let s = 1; s <= 60; s++) SW.step(w3, w3.t + 1000, { keep: new Set(ev.keys) });
  ok(coin.px / c0 > 2.5, `Elon tweet: ${coin.sym} x${(coin.px / c0).toFixed(1)}`);
  ok(ev.text.includes(coin.sym), "names the coin");
  const ends = [];
  for (let s = 1; s <= 5; s++) ends.push(...SW.step(w3, w3.t + 1000).filter(e => e.kind === "end"));
  eq(ends.length, 1, "event ends at its countdown");
  for (const type of SW.EVENT_IDS) { const e = SW.forceEvent(fresh(30), type); ok(e.icon && e.title && e.until > e.start, type); }
  const sq = SW.forceEvent(fresh(31), "shortSqueeze");
  ok(sq.keys.length >= 1 && sq.keys.every(k => k.startsWith("stock:")), "short squeeze on stocks");
});

await test("Sim: liquidation cascades when many are leveraged", () => {
  const w = fresh(8);
  for (const i of byM(w, "crypto")) i.crowd = 0.2; // a calm crowd: no cascade on its own
  const i = w.insts["crypto:HEL"];
  const lev = SW.leverageByKey([{ margin: { a: { key: i.key, dir: 1, cost: 5000, lev: 50 }, b: { key: i.key, dir: -1, cost: 900, lev: 10 } } }]);
  eq(lev[i.key], 250000, "leveraged longs in USD");
  SW.forceEvent(w, "blackSwan");
  const calm = [], hot = [];
  const w2 = JSON.parse(JSON.stringify(w));
  for (let s = 1; s <= 45; s++) {
    calm.push(...SW.step(w, w.t + 1000).filter(e => e.kind === "cascade" && e.key === i.key));
    hot.push(...SW.step(w2, w2.t + 1000, { lev }).filter(e => e.kind === "cascade" && e.key === i.key));
  }
  eq(calm.length, 0, "no cascade with few leveraged");
  ok(hot.length >= 1 && hot[0].usd > 0, "cascade with your 50x long: " + JSON.stringify(hot[0]));
  ok(w2.insts[i.key].px < w.insts[i.key].px, "the cascade pushes the price lower");
});

await test("Sim: candles 1m / 5m / 1h / 1d, prices back in time, Time machine minutes", () => {
  const w = fresh(4);
  const i = w.insts["stock:EMBR"];
  const b5 = SW.bars(i, "5m"), b1 = SW.bars(i, "1m");
  eq(b5.length, 72, "6 hours of 5-minute candles");
  eq(b5[1].o, b1[5].o, "5m open = first 1m open"); eq(b5[1].c, b1[9].c, "5m close = last 1m close");
  near(b5[1].h, Math.max(...b1.slice(5, 10).map(b => b.h)), "5m high");
  ok(SW.bars(i, "1h").length >= 239 && SW.bars(i, "1d").length >= 119, "hourly and daily");
  const day = ST0 - 2 * SW.DAY;
  const mins = SW.minuteHistory(i, day, day + 4 * SW.HOUR);
  eq(mins.length, 240, "240 minutes for 4 old hours");
  const h = i.bh.find(b => b[0] === Math.floor(day / SW.HOUR) * SW.HOUR);
  eq(mins[0].o, h[1], "follows the hour's open"); eq(mins[59].c, h[4], "and close");
  ok(mins.slice(0, 60).every(b => b.h <= h[2] * (1 + 1e-12) && b.l >= h[3] * (1 - 1e-12)), "inside the hour's high and low");
  deepEq(SW.minuteHistory(i, day, day + SW.HOUR), mins.slice(0, 60), "always the same minutes");
  const rec = SW.minuteHistory(i, ST0 - 3 * SW.HOUR, ST0);
  eq(rec.at(-1).c, i.b1.at(-1)[4], "recent minutes are the real Sim ones");
});

await test("Sim: the app sees Sim prices like a real source: same costs, orders, cheats", () => {
  const w = fresh(6);
  const meme = byM(w, "meme").find(i => !i.dead), fxi = w.insts["fx:USDNMF"];
  const L = SW.quote(w, meme), inst = SW.instOf(meme);
  ok(L.px > 0 && L.liq > 0 && L.mc > 0 && "ch5m" in L, "meme quote");
  eq(inst.m, "meme"); eq(inst.sim, 1, "marked Sim");
  const qb = quoteBuy(inst, 1000, { px: L.px, liq: L.liq });
  near(qb.fee, 10, "1% fee as in Live");
  ok(qb.slip > 0, "price impact as in Live");
  const qf = quoteBuy(SW.instOf(fxi), 1000, { px: fxi.px, quoteUsd: w.cur.NMF.usd });
  near(qf.fee, 0, "forex: no commission"); ok(qf.slip > 0 && qf.slip < 0.5, "forex: half a typical spread " + qf.slip);
  const s = E.newPortfolio(ST0);
  const q = { px: L.px, t: ST0, liq: L.liq };
  E.executeBuy(s, inst, 500, q, ST0, "manual");
  E.placeOrder(s, inst, { side: "sell", type: "limit", frac: 1, limit: L.px * 2 }, q, ST0, { open: true, since: 0 });
  const ev = E.checkKey(s, inst.key, { ...q, px: L.px * 2.1 }, ST0 + 1000, { open: true, since: 0 });
  ok(ev.some(e => e.type === "fill") && !s.pos[inst.key], "limit order filled on a Sim pump");
  eq(SW.lists(w).fresh[0], byM(w, "meme").sort((a, b) => b.born - a.born)[0].key, "New list: newest first");
  ok(SW.search(w, "stock", "nova").includes("stock:NVMT"), "search by name");
});

await test("Oracle: the future it plays on a copy of the Sim world is exactly what then happens", () => {
  const w = fresh(41);
  const coin = byM(w, "meme").filter(i => !i.dead).sort((a, b) => b.born - a.born)[0];
  const keep = new Set([coin.key, "crypto:NBL"]);
  const lev = { "crypto:NBL": 50000 };
  const t = w.t, px0 = coin.px;
  const f = SW.future(w, coin.key, 600, { keep, lev });
  eq(w.t, t, "the real world did not move"); eq(coin.px, px0, "nor its price");
  eq(f.path.length, 600, "600 seconds ahead");
  const real = [];
  for (let s = 1; s <= 600; s++) { SW.step(w, t + s * 1000, { keep, lev }); real.push([w.t, w.insts[coin.key].px]); }
  eq(JSON.stringify(real), JSON.stringify(f.path), "same prices, second by second");
  eq(JSON.stringify(f.inst.b1.slice(-3)), JSON.stringify(w.insts[coin.key].b1.slice(-3)), "same candles");
  // other coins dropped differently do not change this coin's future (each coin has its own random stream)
  const w2 = fresh(41), c2 = w2.insts[coin.key];
  const f2 = SW.future(w2, coin.key, 300, { keep: new Set([coin.key]), lev });
  for (let s = 1; s <= 300; s++) SW.step(w2, t + s * 1000, { keep: new Set([coin.key, ...byM(w2, "meme").slice(0, 8).map(i => i.key)]), lev });
  eq(c2.px, f2.path.at(-1)[1], "a different keep set, same future for this coin");
});

await test("Oracle: BUY at the best moment to enter, SELL = max profit at the peak", () => {
  const path = [[1, 9], [2, 7], [3, 12], [4, 5], [5, 11], [6, 13], [7, 4], [8, 6]];
  const b = SW.bestTrade(path, 0, 10);
  eq(b.buy.t, 4, "buy at the low before the biggest gain"); eq(b.buy.px, 5, "buy price");
  eq(b.sell.t, 6, "sell at the peak after it"); eq(b.sell.px, 13, "sell price"); near(b.gain, 1.6, "+160%");
  eq(SW.bestTrade([[1, 9], [2, 8], [3, 7]], 0, 10), null, "only goes down: no trade");
  near(SW.bestTrade([[1, 12]], 0, 10).gain, 0.2, "buy now if now is the low");
  eq(SW.bestTrade([[1, 12]], 0, 10).buy.t, 0, "now");
});

await test("Skip ahead: +1h / +1d / +1w plans, long steps keep pumps and events to their real length", () => {
  const sum = p => p.reduce((a, x) => a + x.dt * x.n * 1000, 0);
  deepEq(SW.skipPlan(SW.SKIPS["1h"]), [{ dt: 20, n: 180 }], "1 hour: 20-second steps");
  deepEq(SW.skipPlan(SW.SKIPS["1d"]), [{ dt: 300, n: 216 }, { dt: 20, n: 1080 }], "1 day: 5-minute steps, then the last 6 hours in 20 s");
  for (const k in SW.SKIPS) eq(sum(SW.skipPlan(SW.SKIPS[k])), SW.SKIPS[k], k + " adds up");
  // a +1,000% pump of 3 minutes inside one 5-minute step: the full pump, not more
  const w = fresh(42);
  const c = byM(w, "meme").filter(i => !i.dead).at(-1);
  Object.assign(c.fate, { kind: "pump", pumpAt: w.t + 60e3, pumpDur: 180, mult: 11, rugAt: null });
  c.pumping = false;
  const p0 = c.px;
  const out = SW.stepBy(w, 300, { keep: new Set([c.key]) });
  ok(c.px / p0 > 4 && c.px / p0 < 40, `pump x${(c.px / p0).toFixed(1)} in one long step`);
  ok(out.some(e => e.kind === "pump" && e.key === c.key) && c.b1.at(-1)[5] === 1, "pump reported, gold candle");
  // a 75-second Bull run inside one 5-minute step moves crypto like 75 seconds of Bull run
  const w1 = fresh(43), w2 = fresh(43);
  SW.forceEvent(w1, "bull"); SW.forceEvent(w2, "bull");
  const a = Object.fromEntries(byM(w1, "crypto").map(i => [i.key, i.px]));
  SW.stepBy(w1, 300); for (let s = 0; s < 300; s++) SW.stepBy(w2, 1);
  const avg = w => byM(w, "crypto").reduce((x, i) => x + Math.log(i.px / a[i.key]), 0) / 14;
  ok(Math.abs(avg(w1) - avg(w2)) < 0.012 && avg(w1) > 0.02, `long step ${avg(w1).toFixed(4)} vs 1-second steps ${avg(w2).toFixed(4)} (bull: +0.0006/s × 75 s)`);
});

await test("Skip ahead: a whole week of Sim runs fast and leaves complete candles", () => {
  const w = fresh(44);
  const t0 = w.t, t = performance.now(), seen = {};
  for (const seg of SW.skipPlan(SW.SKIPS["1w"])) for (let k = 0; k < seg.n; k++) for (const e of SW.stepBy(w, seg.dt, { keep: new Set(["crypto:NBL"]) })) seen[e.kind] = (seen[e.kind] || 0) + 1;
  const ms = performance.now() - t;
  eq(w.t, t0 + SW.SKIPS["1w"], "a week later");
  ok(ms < 15000, `a week in ${Math.round(ms)} ms`);
  const i = w.insts["crypto:NBL"], b1 = i.b1;
  eq(b1.length, 360, "6 hours of 1-minute candles");
  ok(b1.every((b, k) => !k || b[0] - b1[k - 1][0] === 60e3), "no gaps in the 1-minute candles");
  ok(i.bh.filter(b => b[0] > t0).length >= 167, "hourly candles for the whole week");
  ok(seen.event > 80 && seen.coin > 1000 && seen.rug > 100 && seen.pump > 50, JSON.stringify(seen));
  ok(byM(w, "meme").length <= SW.MAX_MEMES + 1, "memecoins still capped");
  const rs = [...byM(w, "crypto"), ...byM(w, "stock"), ...byM(w, "fx")].map(x => [x.sym, x.px / (x.m === "fx" ? x.bd[0][4] : x.px0)]).sort((a, b) => a[1] - b[1]);
  const show = rs.slice(0, 2).concat(rs.slice(-2)).map(([k, r]) => `${k} x${r.toFixed(2)}`).join(", ");
  ok(rs[0][1] > 1 / 8 && rs.at(-1)[1] < 8, "prices stay in a sane range after a week of events: " + show);
});

await test("Last chance: the high since you bought, the drop from it, and the trailing stop", () => {
  const s = E.newPortfolio(ST0), BTC = { key: "crypto:BTCUSDT", m: "crypto", id: "BTCUSDT", sym: "BTC", name: "Bitcoin" };
  const OPEN = { open: true, since: 0 };
  E.executeBuy(s, BTC, 1000, { px: 100, t: ST0 }, ST0);
  eq(s.pos[BTC.key].best, 100, "starts at the buy price");
  E.checkKey(s, BTC.key, { px: 120, t: ST0 + 1 }, ST0 + 1, OPEN, { trail: 0.1 });
  E.checkKey(s, BTC.key, { px: 115, t: ST0 + 2 }, ST0 + 2, OPEN, { trail: 0.1 });
  eq(s.pos[BTC.key].best, 120, "the high since you bought");
  near(E.drawdown(s.pos[BTC.key], 108), 0.1, "−10% from 120 at 108");
  eq(E.checkKey(s, BTC.key, { px: 108.5, t: ST0 + 3 }, ST0 + 3, OPEN, { trail: 0.1 }).length, 0, "−9.6%: still held");
  eq(E.checkKey(s, BTC.key, { px: 107, t: ST0 + 4 }, ST0 + 4, OPEN).length, 0, "no trailing stop without the setting");
  const ev = E.checkKey(s, BTC.key, { px: 107, t: ST0 + 5 }, ST0 + 5, OPEN, { trail: 0.1 });
  eq(ev.length, 1, "−10.8%: sold"); eq(ev[0].type, "trail", "trailing stop"); eq(ev[0].trade.reason, "trail", "reason"); eq(ev[0].best, 120, "from the high");
  ok(!s.pos[BTC.key], "position closed");
  // closed market: the high is tracked, nothing sells
  const s2 = E.newPortfolio(ST0), AAPL = { key: "stock:AAPL", m: "stock", id: "AAPL", sym: "AAPL", name: "Apple" };
  E.executeBuy(s2, AAPL, 1000, { px: 200, t: ST0 }, ST0);
  eq(E.checkKey(s2, AAPL.key, { px: 150, t: ST0 + 1 }, ST0 + 1, { open: false }, { trail: 0.1 }).length, 0, "market closed: waits");
  // a short watches the low
  const s3 = E.newPortfolio(ST0);
  E.openMargin(s3, BTC, 1000, 10, -1, { px: 100, t: ST0 }, ST0, "manual");
  const m = Object.values(s3.margin)[0];
  E.checkKey(s3, BTC.key, { px: 95, t: ST0 + 1 }, ST0 + 1, OPEN);
  eq(m.best, 95, "short: the low since you opened"); near(E.drawdown(m, 99.75), 0.05, "+5% from the low");
  const ev3 = E.checkKey(s3, BTC.key, { px: 99.8, t: ST0 + 2 }, ST0 + 2, OPEN, { trail: 0.05 });
  ok(ev3.length === 1 && ev3[0].type === "trail" && !Object.keys(s3.margin).length, "short closed by the trailing stop");
});

await test("Sim: combo multiplier, jackpots at 10x and the records table", () => {
  eq([1, 2, 3, 4, 5, 6, 40].map(FUN.comboMult).join(), "1,2,3,5,8,13,100", "x1 x2 x3 x5 x8 x13 … x100");
  const r = FUN.newRecords();
  const win = { pl: 10 }, loss = { pl: -3 };
  FUN.onSale(r, win, 1); const two = FUN.onSale(r, win, 2); const three = FUN.onSale(r, win, 3);
  ok(two.up && two.mult === 2 && three.mult === 3, "combo goes up");
  const broke = FUN.onSale(r, loss, 4);
  ok(broke.broke && r.wins === 0, "a loss breaks it");
  FUN.onSale(r, win, 5);
  eq(r.combo.x, 3, "best multiplier kept"); eq(r.streak.n, 3, "longest streak kept");
  const ps = [{ cost: 100 }, { cost: 100 }, { cost: 0 }];
  const vals = [1200, 300, 50];
  const j = FUN.newJackpots(ps, p => vals[ps.indexOf(p)]);
  eq(j.length, 1, "one jackpot"); near(j[0].mult, 12, "12x"); near(j[0].usd, 1100, "gain");
  eq(FUN.newJackpots(ps, p => vals[ps.indexOf(p)]).length, 0, "counted once");
  ok(FUN.onJackpot(r, { sym: "A", mult: 12, usd: 1100 }, 6), "first jackpot record");
  ok(!FUN.onJackpot(r, { sym: "B", mult: 11, usd: 50 }, 7), "smaller one does not beat it");
  ok(FUN.onRug(r, { sym: "R", usd: 400, pct: 0.98 }, 8) && !FUN.onRug(r, { sym: "S", usd: 10, pct: 0.9 }, 9), "worst rug");
  eq(r.rug.sym, "R", "worst rug kept");
});

// ---------------------------------------------------------------- extras: achievements, candles
await test("Achievements: first win, +50%, surviving -30%, 4 markets and streak", () => {
  const s = E.newPortfolio(T0);
  const a = newAchievements();
  const day = d => Date.UTC(2026, 10, d, 17, 0);
  E.executeBuy(s, MEME, 100, { px: 1, liq: 1e9, t: day(20) }, day(20));
  E.checkKey(s, MEME.key, { px: 0.65, liq: 1e9, t: day(20) }, day(20), ALWAYS); // fell 35%
  E.executeSell(s, MEME.key, 1, { px: 1.7, liq: 1e9, t: day(20) }, day(20));
  E.executeBuy(s, BTC, 100, { px: 100, t: day(21) }, day(21)); E.executeSell(s, BTC.key, 1, { px: 110, t: day(21) }, day(21));
  E.executeBuy(s, AAPL, 100, { px: 100, t: day(22) }, day(22)); E.executeSell(s, AAPL.key, 1, { px: 110, t: day(22) }, day(22));
  E.executeBuy(s, EURUSD, 100, { px: 1, quoteUsd: 1, t: day(22) }, day(22));
  const got = evaluate(a, s.trades, { trades: s.trades, total: 100100, start: s.start, now: day(22) });
  for (const id of ["first_trade", "first_win", "win_50", "survivor", "four_markets", "streak_3"]) ok(got.includes(id), "missing " + id);
  eq(greenStreak(s.trades, day(23)), 3, "3-day streak (the current day doesn't break it yet)");
  const sb = scoreboard(s.trades);
  eq(sb.all.n, 3, "3 closed"); eq(sb.all.winRate, 1, "100% winners"); eq(sb.meme.best.sym, "GHOST", "best per market");
});

await test("Candles: the live price moves the last candle or opens a new one", () => {
  const bars = [];
  applyTick(bars, "1m", 60000, 10); applyTick(bars, "1m", 90000, 12); applyTick(bars, "1m", 110000, 9);
  eq(bars.length, 1, "same candle"); eq(bars[0].h, 12, "high"); eq(bars[0].l, 9, "low"); eq(bars[0].c, 9, "close");
  applyTick(bars, "1m", 125000, 11);
  eq(bars.length, 2, "new candle"); eq(bars[1].o, 9, "opens where the previous one closed");
  eq(ticksToBars([{ t: 0, px: 1 }, { t: 300000, px: 2 }], "5m").length, 2, "from live prices to candles");
  ok(cacheIsFresh({ bars: [{ t: 0 }] }, "1d", 86400e3 + 3600e3), "a recent daily candle is still good");
  ok(!cacheIsFresh({ bars: [{ t: 0 }] }, "1m", 3600e3), "old 1m candles are not");
});

// ---------------------------------------------------------------- report
await test("Numbers · big ones abbreviated ($1.25K, $3.4M, $12.7B, $1.05T, +1.2M%), never e+24; full on request", () => {
  eq(F.usd(1250), "$1.25K"); eq(F.usd(3.4e6), "$3.4M"); eq(F.usd(12.7e9), "$12.7B"); eq(F.usd(1.05e12), "$1.05T");
  eq(F.usd(999.99), "$999.99", "under $1,000: every cent"); eq(F.usd(1000), "$1K"); eq(F.usd(999999), "$1M", "rounds up a suffix");
  eq(F.usd(100000), "$100K"); eq(F.usd(-25000), "-$25K"); eq(F.usd(1234, { sign: true }), "+$1.23K");
  eq(F.usd(1250, { full: true }), "$1,250.00", "full number");
  eq(F.usd(7.268689556e12, { full: true }), "$7,268,689,556,000.00");
  eq(F.pct(1.2e6), "+1.2M%"); eq(F.pct(12345), "+12.3K%"); eq(F.pct(-45.678), "-45.68%"); eq(F.pct(9999.5, 0), "+10000%");
  for (const x of [F.usd(1e24), F.usd(1e40), F.pct(1e26), F.pct(1e26, 2, { full: true }), F.qty(1e-9), F.qty(3e25), F.price(1e-9), F.price(2e22), F.price(1e9, 5), F.usd(1e24, { full: true })])
    ok(!/e[+-]?\d/.test(x), "no scientific notation: " + x);
  eq(F.usd(1e24), "$1Sp"); eq(F.price(123456), "$123K"); eq(F.price(123456, null, { full: true }), "$123,456.00"); eq(F.price(1.08765, 5), "1.08765");
  eq(F.qty(2.5e6), "2.5M"); eq(F.qty(0.000012345), "0.00001234");
  eq(F.tap("$1.25K", "$1,250.00"), `<span class="ab" data-full="$1,250.00">$1.25K</span>`, "tap shows the full number");
  eq(F.tap("$5.00", "$5.00"), "$5.00", "nothing to tap when it's already full");
});

await test("Money cap · no portfolio passes the world's 100 richest together; Billionaire ladder", () => {
  eq(RICH.RICHEST.length, 100); ok(RICH.AS_OF > 0 && RICH.SOURCE.includes("Forbes"), "source and date");
  near(RICH.WORLD_CAP, RICH.RICHEST.reduce((a, r) => a + r[2], 0), "the sum of the 100");
  ok(RICH.RICHEST.every((r, i) => !i || r[2] <= RICH.RICHEST[i - 1][2]), "sorted");
  const s = E.newPortfolio(T0, 100000);
  s.cash = RICH.WORLD_CAP - 1e9;
  E.executeBuy(s, BTC, 1e9, { px: 60000, t: T0 }, T0);
  const tr = E.executeSell(s, BTC.key, 1, { px: 600000, t: T0 + 1 }, T0 + 1); // 10x
  ok(tr.capped > 7.9e9 && tr.capped < 8e9, "the gain past the cap is cut (8B over, less fees): " + tr.capped);
  near(E.totals(s, () => null).total, RICH.WORLD_CAP, "the portfolio stays at the cap", 1e-12);
  ok(E.totals(s, () => null).capped, "capped flag");
  const cut = E.addCash(s, 1e6);
  near(cut, 1e6, "Money printer at the cap prints nothing", 1e-6); near(s.cash, RICH.WORLD_CAP, "still at the cap", 1e-12);
  // a position worth more than the cap on paper: the total shows the cap
  const h = E.newPortfolio(T0, 100000);
  E.executeBuy(h, MEME, 1000, { px: 1, liq: 1e30, t: T0 }, T0);
  ok(E.totals(h, () => ({ px: 1e12, liq: 1e30, t: T0 })).total <= RICH.WORLD_CAP, "a moonshot shows the cap");
  // Double or nothing at the cap
  const d = cheated(); d.cash = RICH.WORLD_CAP - 2e9;
  E.executeBuy(d, BTC, 1e9, { px: 60000, t: T0 }, T0); E.executeSell(d, BTC.key, 1, { px: 66000, t: T0 }, T0);
  C.doubleOrNothing(d, 0.1, T0 + 1);
  ok(d.cash <= RICH.WORLD_CAP + 0.01, "doubling stops at the cap too");
  // the ladder
  const lo = RICH.ladder(5000);
  eq(lo.place, 101, "$5K: not in the top 100"); eq(lo.above[0], 100, "#100 is the one to reach");
  const top = RICH.ladder(RICH.RICHEST[0][2] + 1);
  eq(top.place, 1, "richer than #1"); eq(top.above, null, "nobody above");
  const mid = RICH.ladder(RICH.RICHEST[2][2] + 1);
  eq(mid.place, 3, "just above #3 takes #3"); eq(mid.above[0], 2, "#2 is next");
  eq(RICH.ladder(RICH.RICHEST[2][2]).place, 4, "a tie doesn't pass them");
});

await test("Always on · re-arms a one-shot cheat after every trade; not for toggles", () => {
  const s = cheated();
  for (const id of C.ALWAYS) ok(C.CHEAT[id].kind === "arm" || id === "don", id + " is a one-shot cheat");
  C.setAlways(s, "golden", true, T0);
  ok(C.isAlways(s, "golden") && C.isArmed(s, "golden"), "on and armed"); ok(E.isCheated(s), "★");
  s.cheats.armed.golden = false; // used by a buy
  deepEq(C.rearm(s), ["golden"], "armed again after the trade"); ok(C.isArmed(s, "golden"));
  deepEq(C.rearm(s), [], "nothing to do while it's armed");
  C.setAlways(s, "golden", false, T0 + 1); s.cheats.armed.golden = false;
  deepEq(C.rearm(s), [], "off: it stays used up");
  C.setAlways(s, "don", true, T0); ok(C.isAlways(s, "don"), "Double or nothing can be always on (it asks after every win)");
  let threw = false; try { C.setAlways(s, "printer", true, T0); } catch { threw = true; }
  ok(threw, "Money printer can't be always on");
  threw = false; try { C.setAlways(s, "undo", true, T0); } catch { threw = true; }
  ok(threw, "Undo can't be always on");
});

await test("Bot cheats · any time, as it suits them, Money printer once a day; same engine rules; can be turned off", () => {
  const ids = BOT_CHEATS.map(c => c.id);
  deepEq(ids, ["zeroFees", "insurance", "lucky", "rugShield", "golden", "perfect", "leverage", "printer"], "the list");
  for (const bad of ["undo", "ghost", "oracle", "xray", "timeMachine", "skip"]) ok(!ids.includes(bad), "never " + bad);
  const turn = (b, px, t, o = {}) => botStep(b, { entries: [L(o.inst || BTC, px, t, { ch24: 5, ...o.e })], now: t, status: statusAt(t), bootAt: 0, extreme: o.extreme, cheats: o.cheats ?? true });
  const usedOf = (b, id) => b.pf.cheats?.used?.[id] || 0;
  // no daily limit: every winning sale uses Perfect exit and 2x Lucky trade
  const n = newBot("momentum", { id: "n", start: 100000, now: T0, seed: 1 });
  for (let i = 0; i < 5; i++) {
    const t = T0 + i * 600e3;
    cheatTick(n, t, {});
    turn(n, 60000, t);
    const [s] = turn(n, 66000, t + 60e3, { extreme: (k, from, kind) => (kind === "high" ? 69000 : null) });
    ok(s?.cheat?.includes("Perfect exit") && s.cheat.includes("2x Lucky trade"), "winning sale " + i + ": " + JSON.stringify(s?.cheat));
  }
  eq(usedOf(n, "perfect"), 5, "5 Perfect exits in one day"); ok(E.isCheated(n.pf), "★ on the bot");
  // only when it suits it
  const c0 = newBot("momentum", { id: "c", start: 100000, now: T0, seed: 2 });
  turn(c0, 60000, T0); ok(!E.isCheated(c0.pf), "a small, ordinary buy: no cheat");
  turn(c0, 54000, T0 + 60e3, { extreme: () => 69000 });
  eq(usedOf(c0, "perfect"), 0, "no Perfect exit on a loss"); eq(usedOf(c0, "insurance"), 1, "Insurance on a loss");
  // a risky buy: strong signal, so Leverage, and Insurance armed before it
  const rk = newBot("momentum", { id: "rk", start: 100000, now: T0, seed: 2 });
  const [rt] = turn(rk, 60000, T0, { e: { ch24: 9 }, extreme: (k, from, kind) => (kind === "low" ? 57000 : null) });
  eq(rt.lev, 10, "leverage on a strong signal"); ok(C.isArmed(rk.pf, "insurance"), "insured first"); eq(rt.fee, 0, "Zero fees");
  ok(rt.cheat.includes("Golden entry"), "Golden entry: the low is well below");
  // a big memecoin bet: Rug shield
  const dg = newBot("degen", { id: "dg", start: 100000, now: T0, seed: 2 });
  turn(dg, 0.001, T0, { inst: MEME, e: { ch1h: 40, liq: 1e6 } });
  ok(C.isOn(dg.pf, "rugShield") && C.isArmed(dg.pf, "insurance"), "shielded and insured: " + JSON.stringify(dg.pf.cheats?.used));
  // bots not allowed: plain trades
  const off = newBot("momentum", { id: "off", start: 100000, now: T0, seed: 2 });
  turn(off, 60000, T0, { e: { ch24: 9 }, extreme: () => 57000, cheats: false }); ok(!off.pf.cheats, "off: no cheats");
  // Money printer: 10% of its balance, when losing, once a day
  const p = newBot("momentum", { id: "p", start: 100000, now: T0, seed: 9 });
  eq(cheatTick(p, T0, {}).length, 0, "not needed yet");
  p.pf.cash = 90000;
  const [u] = cheatTick(p, T0, {});
  eq(u.id, "printer", "losing: prints"); near(p.pf.cash, 99000, "+10%");
  for (let i = 1; i <= 20; i++) eq(cheatTick(p, T0 + i * 1000, {}).length, 0, "once a day");
  cheatTick(p, T0 + 30e3, { allowed: false }); eq(cheatTick(p, T0 + 31e3, {}).length, 0, "not again after off and on");
  eq(cheatTick(p, T0 + 24 * 3600e3, {}).length, 1, "again the next day");
  const sv = newBot("momentum", { id: "sv", start: 100000, now: T0, seed: 9 });
  sv.pf.cash = 90000; sv.cheatDay = localDay(T0); sv.cheatsToday = ["printer"]; sv.cheatPlan = [T0];
  eq(cheatTick(sv, T0, {}).length, 0, "a saved bot that printed today doesn't print again");
  // Zero fees for 1 hour, then it ends
  const z = newBot("momentum", { id: "z", start: 100000, now: T0, seed: 3 });
  C.state(z.pf).on.zeroFees = true; z.pf.cheats.until = { zeroFees: T0 + 3600e3 };
  cheatTick(z, T0, {});
  const [zt] = turn(z, 60000, T0, { cheats: false });
  eq(zt.fee, 0, "no fee during the hour");
  cheatTick(z, T0 + 3600e3 + 1, {}); ok(!C.isOn(z.pf, "zeroFees"), "over after 1 hour");
  // Golden entry: the low of the last 15 minutes; Perfect exit: the high of the day
  const g = newBot("momentum", { id: "g", start: 100000, now: T0, seed: 4 });
  C.state(g.pf).armed.golden = true;
  let span = null;
  const [gt] = botStep(g, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0, extreme: (k, from, kind) => { span = T0 - from; return kind === "low" ? 57000 : null; } });
  eq(span, 15 * 60e3, "the last 15 minutes");
  ok(gt.px < 58000 && gt.cheat?.includes("Golden entry"), "bought near the 15-minute low: " + gt.px); ok(!C.isArmed(g.pf, "golden"), "used up");
  C.state(g.pf).armed.perfect = true;
  const [st] = botStep(g, { entries: [L(BTC, 54000, T0 + 60e3, { ch24: 5 })], now: T0 + 60e3, status: statusAt(T0 + 60e3), bootAt: 0, extreme: (k, from, kind) => kind === "high" ? 63000 : null });
  ok(st?.side === "sell" && st.px > 62000 && st.cheat?.includes("Perfect exit"), "sold at the day's high: " + st?.px);
  // Leverage 20x: a margin position the bot closes, or is liquidated with the real rules
  const v = newBot("momentum", { id: "v", start: 100000, now: T0, seed: 5 });
  C.state(v.pf).lev = 20;
  const [vt] = botStep(v, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  eq(vt.lev, 20, "20x"); eq(E.marginPositions(v.pf).length, 1, "a leveraged position"); eq(C.leverage(v.pf), 1, "only on that buy");
  const out = botStep(v, { entries: [L(BTC, 56000, T0 + 60e3, { ch24: 5 })], now: T0 + 60e3, status: statusAt(T0 + 60e3), bootAt: 0 });
  ok(out.some(t => t.why === "liquidated"), "-6.7% at 20x: liquidated: " + out.map(t => t.why).join(","));
  eq(E.marginPositions(v.pf).length, 0, "closed");
  // Lucky trade doubles the bot's win, with the same rule as yours
  const k = newBot("momentum", { id: "k", start: 100000, now: T0, seed: 6 });
  botStep(k, { entries: [L(BTC, 60000, T0, { ch24: 5 })], now: T0, status: statusAt(T0), bootAt: 0 });
  C.state(k.pf).armed.lucky = true; C.mark(k.pf, "lucky", "2x Lucky trade", T0);
  const [kt] = botStep(k, { entries: [L(BTC, 66000, T0 + 60e3, { ch24: 5 })], now: T0 + 60e3, status: statusAt(T0 + 60e3), bootAt: 0 });
  ok(kt?.cheat?.some(x => /Lucky/.test(x)), "2x Lucky trade on its win: " + JSON.stringify(kt?.cheat));
  // Settings off: nothing armed
  cheatTick(k, T0 + 1, { allowed: false });
  ok(!C.isArmed(k.pf, "lucky") && !C.isOn(k.pf, "zeroFees"), "Bots can cheat off: nothing armed");
  ok(E.isCheated(k.pf), "the ★ stays: it cheated before");
  // an imported bot keeps its cheats (but never Undo)
  const list = [JSON.parse(JSON.stringify(k))]; list[0].pf.cheats.always = { golden: true }; list[0].pf.undo = {};
  ok(validBots(list), "valid"); ok(list[0].pf.cheats?.always?.golden && !list[0].pf.undo, "cheats and Always on kept, Undo dropped");
});

await test("Bot difficulty · bets, leverage and Always on of each level", () => {
  const turn = (b, diff, t, e = {}, o = {}) => botStep(b, { entries: [L(o.inst || BTC, o.px || 60000, t, { ch24: 5, ...e })], now: t, status: statusAt(t), bootAt: 0, cheats: o.cheats ?? true, diff, extreme: o.extreme, peers: o.peers });
  for (const [diff, lo, hi, maxLev] of [["normal", 0.1, 0.25, 10], ["hard", 0.25, 0.5, 50], ["insane", 0.5, 0.9, 100]]) {
    const sizes = [], levs = [];
    for (let seed = 1; seed <= 60; seed++) for (const style of ["momentum", "contrarian", "random"]) {
      const b = newBot(style, { id: "d" + seed, start: 100000, now: T0, seed }), ch24 = (style === "contrarian" ? -1 : 1) * (seed % 2 ? 5 : 20);
      cheatTick(b, T0, { diff });
      const t = turn(b, diff, T0, { ch24 }).find(x => x.side === "buy" && x.reason === "bot");
      if (t) { sizes.push(t.usd / 100000); levs.push(t.lev || 1); }
    }
    ok(sizes.length > 100, diff + ": they bet " + sizes.length);
    ok(Math.min(...sizes) >= lo - 1e-4 && Math.max(...sizes) <= hi + 1e-4, `${diff}: ${Math.min(...sizes)}–${Math.max(...sizes)} of its cash`);
    eq(Math.max(...levs), maxLev, diff + ": leverage up to");
  }
  // Easy: exactly the same as without a difficulty
  const run = o => { const b = newBot("momentum", { id: "x", start: 100000, now: T0, seed: 1 }); cheatTick(b, T0, o); return botStep(b, { entries: [L(BTC, 60000, T0, { ch24: 9 })], now: T0, status: statusAt(T0), bootAt: 0, cheats: true, ...o }); };
  deepEq(run({ diff: "easy" }), run({}), "Easy as before"); near(run({ diff: "easy" })[0].usd, 6000, "6% of its balance");
  // cheats off: the bet grows, no leverage
  const off = newBot("momentum", { id: "o", start: 100000, now: T0, seed: 4 });
  cheatTick(off, T0, { diff: "insane", allowed: false });
  const [ot] = turn(off, "insane", T0, { ch24: 9 }, { cheats: false });
  ok(ot.usd >= 50000 && !ot.lev && !off.pf.cheats, "cheats off: a plain, big buy");
  // one leveraged position per coin
  const one = newBot("momentum", { id: "1", start: 100000, now: T0, seed: 4 });
  turn(one, "normal", T0); turn(one, "normal", T0 + 200e3); eq(E.marginPositions(one.pf).length, 1, "it doesn't pile on the same coin");
  // a thin memecoin: no more than 5% of its pool
  const dg = newBot("degen", { id: "dg", start: 100000, now: T0, seed: 2 });
  const [mt] = turn(dg, "hard", T0, { ch1h: 40, liq: 100000 }, { inst: MEME, px: 0.001, cheats: false });
  near(mt.usd, 5000, "5% of a $100K pool");
  // Hard: what it uses stays on Always on; Normal's is used up
  for (const [diff, always] of [["normal", false], ["hard", true]]) {
    const h = newBot("momentum", { id: "h", start: 100000, now: T0, seed: 2 });
    cheatTick(h, T0, { diff });
    turn(h, diff, T0, { ch24: 9 }, { extreme: (k, f, kind) => (kind === "low" ? 57000 : null) });
    eq(C.isAlways(h.pf, "golden"), always, diff + ": Golden entry always on"); eq(C.isArmed(h.pf, "golden"), always, diff + ": armed again");
    cheatTick(h, T0 + 2 * 3600e3, { diff }); eq(C.isOn(h.pf, "zeroFees"), always, diff + ": Zero fees after its hour");
    if (always) { cheatTick(h, T0 + 3 * 3600e3, { diff: "normal" }); ok(!C.isAlways(h.pf, "golden") && !C.isArmed(h.pf, "golden") && !C.isOn(h.pf, "zeroFees"), "back to Normal: nothing left on"); }
  }
  // Insane: your cheats except Undo, Oracle and Time machine, always on
  const z = newBot("momentum", { id: "z", start: 100000, now: T0, seed: 3 });
  cheatTick(z, T0, { diff: "insane" });
  for (const c of C.CHEATS) if (c.kind === "toggle") eq(C.isOn(z.pf, c.id), !NEVER.includes(c.id), c.id);
  for (const c of C.CHEATS) if (c.kind === "arm") ok(C.isAlways(z.pf, c.id) && C.isArmed(z.pf, c.id), c.id + " always on");
  for (const id of ["undo", "oracle", "timeMachine", "timeSkip"]) ok(!z.pf.cheats.used[id], "never " + id);
  const round = JSON.parse(JSON.stringify(z)); ok(validBots([round]) && C.isAlways(round.pf, "golden"), "kept when saved");
  // short on the opposite signal; airdrop and Moon boost
  const sh = turn(z, "insane", T0, { ch24: -9 });
  ok(sh.some(t => t.dir === -1 && t.lev > 1), "shorts a falling coin: " + JSON.stringify(sh.map(t => [t.dir, t.lev])));
  const ad = newBot("degen", { id: "ad", start: 100000, now: T0, seed: 3 });
  cheatTick(ad, T0, { diff: "insane" });
  const got = turn(ad, "insane", T0, { ch1h: 40, liq: 1e6 }, { inst: MEME, px: 0.001 });
  ok(got.some(t => t.reason === "airdrop") && ad.pf.cheats.boost, "airdrop and Moon boost");
  const c0 = ad.pf.cash; turn(ad, "insane", T0 + 30e3, { ch1h: 40, liq: 1e6 }, { inst: MEME, px: 0.0012 });
  cheatTick(ad, T0 + C.BOOST_MS + 1000, { diff: "insane" }); ok(ad.pf.cash > c0, "the boost pays at the end");
  // X-ray: buys before the leading rival
  const lead = newBot("contrarian", { id: "l", start: 200000, now: T0, seed: 3 }), spy = newBot("degen", { id: "s", start: 150000, now: T0, seed: 3 });
  cheatTick(spy, T0, { diff: "insane" });
  const seed0 = lead.seed, sp = turn(spy, "insane", T0, { ch24: -9 }, { peers: [lead] });
  ok(sp.some(t => /X-ray/.test(t.why)), "X-ray: " + JSON.stringify(sp.map(t => t.why))); eq(lead.seed, seed0, "the rival isn't touched"); eq(lead.pf.trades.length, 0);
  // Copycat: far behind the leader, once a day
  const cp = newBot("momentum", { id: "cp", start: 100000, now: T0, seed: 3 }), rich = newBot("momentum", { id: "r", start: 100000, now: T0, seed: 3 });
  rich.pf.cash = 900000;
  ok(cheatTick(cp, T0, { diff: "insane", peers: [rich] }).some(x => x.id === "copycat"), "copies the leader"); near(cp.pf.cash, 900000);
});

await test("Saving · good data is never touched; bad numbers are repaired and the rest is kept", () => {
  const s = sampleState(), before = canon(s), none = [];
  CLEAN.cleanPortfolio(s, T0, none);
  eq(none.length, 0, "no false alarms: " + none.join(", ")); eq(canon(s), before, "untouched");
  const w = SW.createWorld(7, T0), wb = canon(w);
  CLEAN.cleanWorld(w, () => SW.createWorld(8, T0), none);
  eq(none.length, 0, "a good world: " + none.join(", ")); eq(canon(w), wb, "world untouched");
  const b = newBot("momentum", { id: "q", start: 100000, now: T0, seed: 3 });
  eq(CLEAN.cleanBots([b], T0, none).length, 1, "bot"); eq(none.length, 0, "good bot: " + none.join(", "));
  // bad numbers
  const x = sampleState(), is = [], nTrades = x.trades.length, nPos = Object.keys(x.pos).length;
  const expect = x.cash; x.cash = NaN;
  x.pos[BTC.key].qty = Infinity; x.pos[BTC.key].cost = 100;
  x.pos[AAPL.key].lastPx = 1e200;
  x.trades[0].fee = NaN; x.trades.push({ t: NaN });
  CLEAN.cleanPortfolio(x, T0, is);
  near(x.cash, expect + 100, "cash from the history, plus what the damaged position cost");
  eq(Object.keys(x.pos).length, nPos - 1, "the other positions stay"); eq(x.pos[AAPL.key].lastPx, null, "huge price cleared");
  eq(x.trades.length, nTrades, "trades stay"); ok(is.length >= 4, "told: " + is.join(", "));
  ok(isFinite(E.totals(x, () => null).total), "the total is a number");
  const inf = sampleState(); inf.cash = Infinity; CLEAN.cleanPortfolio(inf, T0, []); eq(inf.cash, E.WORLD_CAP, "Infinity: the money cap");
  eq(CLEAN.cleanBots([b, { id: "z", style: "momentum", name: "Z", pf: null }], T0, []).length, 1, "a damaged bot doesn't take the others with it");
  const cfg = CLEAN.cleanSettings({ sound: true, moveTh: NaN, notif: 5, alerts: [{ key: "a", price: 1 }, { key: "b", price: Infinity }] }, { sound: false, moveTh: 5, notif: { fills: true }, alerts: [] }, []);
  ok(cfg.sound === true && cfg.moveTh === 5 && cfg.notif.fills === true && cfg.alerts.length === 1, "settings: only the bad ones go back");
  w.insts["crypto:NBL"].px = NaN; w.insts[w.memes[0]].px = Infinity;
  const nm = w.memes.length, wi = [];
  ok(CLEAN.cleanWorld(w, () => SW.createWorld(8, T0), wi) === w, "same world"); eq(w.memes.length, nm - 1, "only that coin goes");
  ok(w.insts["crypto:NBL"].px > 0 && wi.length === 2, wi.join(", "));
});

await test("Rewind · a point rebuilt from its chain is exactly the world, portfolio and bots of that moment; it goes on the same", () => {
  const w = SW.createWorld(21, T0), s = E.newPortfolio(T0), bots = [newBot("momentum", { id: "m", start: 100000, now: T0, seed: 4 })];
  const idx = [], recs = [], truth = [];
  let prev = null;
  for (let n = 0; n < 130; n++) {
    prev = RW.makePoint(w, s, bots, prev && prev.n + 1 < RW.KEY_EVERY ? prev : null);
    recs.push(prev); idx.push({ t: prev.t, key: prev.key }); truth.push(canon({ w, s: { ...s, undo: null }, bots: bots.map(b => ({ ...b, pf: { ...b.pf, undo: null } })) }));
    for (let k = 0; k < 3; k++) SW.stepBy(w, 300, {});
    const i = w.insts["crypto:NBL"], q = { px: i.px, t: w.t };
    if (n % 2 === 0) E.executeBuy(s, SW.instOf(i), 100, q, w.t); else E.executeSell(s, i.key, 1, q, w.t);
    botStep(bots[0], { entries: Object.values(w.insts).map(x => ({ inst: SW.instOf(x), ...SW.quote(w, x) })), now: w.t, status: () => ALWAYS, bootAt: 0 });
    if (n === 50) { s.trades[s.trades.length - 1].flip = "won"; }
    if (n === 60) s.trades.splice(5, 1); // a Ghost trade erased it
  }
  ok(recs.filter(r => r.key).length === 2, "one complete point a day");
  for (const n of [0, 1, 40, 51, 61, 95, 96, 129]) {
    const chain = RW.chainOf(idx, n).map(p => structuredClone(recs.find(r => r.t === p.t)));
    const b = RW.restore(chain);
    if (canon({ w: b.w, s: b.s, bots: b.bots }) !== truth[n]) throw new Error("point " + n + " differs");
  }
  // a fine point is built on its main point, not on the fine one before it
  const f1 = RW.makePoint(w, s, bots, prev), was = canon(w); SW.stepBy(w, 20, {}); const f2 = RW.makePoint(w, s, bots, prev);
  const ch = RW.chainOf(idx, 129).map(p => recs.find(r => r.t === p.t));
  eq(canon(RW.restore([...ch, f1]).w), was, "fine point 1"); eq(canon(RW.restore([...ch, f2]).w), canon(w), "fine point 2");
  // from a restored world the future is the same
  const a = RW.restore(RW.chainOf(idx, 129).map(p => recs.find(r => r.t === p.t))).w, c = structuredClone(a);
  deepEq(SW.futureAll(a, 60).paths["crypto:NBL"], SW.futureAll(c, 60).paths["crypto:NBL"], "same future");
  const all = SW.futureAll(a, 120), one = SW.future(a, "crypto:NBL", 120);
  ok(one.path.every(([, px], n) => all.paths["crypto:NBL"][n] === px), "futureAll = future");
  eq(RW.pointAt(idx, idx[7].t + 1), 7, "newest at or before"); eq(RW.pointAt(idx, idx[0].t - 1), -1, "too far back");
  const now = idx[129].t + RW.KEEP - 20 * 60e3;
  eq(RW.expired(idx, now).length, 96, "a day's complete point goes once the next one covers the week");
  // the star and the switches stay; the bots' logs go back
  C.mark(s, "oracle", "x", w.t); s.cheats.on.oracle = true;
  const back = RW.carryOver(RW.restore([recs[0]]), s, bots, recs[0].t);
  ok(E.isCheated(back.s) && C.isOn(back.s, "oracle"), "the star stays");
});

await test("Sim · market cap limits: $10T, memecoins $1T; Whale mode 25% per trade; saved coins above come back", () => {
  const w = SW.createWorld(31, T0), mk = w.memes[w.memes.length - 1], m = w.insts[mk], n = w.insts["crypto:NBL"];
  // a saved world with absurd prices
  m.px = 1.39e9; m.dead = false; m.b1[m.b1.length - 1][2] = 1.4e9; n.px = 1e9;
  const s = cheated(); s.memeMax = SW.MEME_MAX_PX;
  s.pos[mk] = { key: mk, inst: SW.instOf(m), qty: 1, cost: 10, avg: 10, lastPx: 1.39e9, best: 1.4e9, sl: 1e9, tp: null, openedAt: T0, minRatio: 1 };
  C.setToggle(s, "whale", true, T0); s.cheats.whale[mk] = 1e6;
  const keys = SW.capWorld(w); SW.capPortfolio(s, w);
  deepEq(keys.sort(), [mk, "crypto:NBL"].sort(), "brought down"); eq(m.px * m.supply, 1e12, "memecoin at $1T"); near(n.px * n.supply, 10e12, "crypto at $10T");
  ok(m.b1.every(b => b[2] <= 1000), "candles too"); const p = s.pos[mk];
  ok(p.best === 1000 && p.lastPx === 1000 && p.sl === null && s.cheats.whale[mk] === 1, "nothing sells because of the old prices");
  eq(SW.capWorld(w).length, 0, "only once"); ok(E.positionValue(s, p, { px: 1000 }) <= 1000, "valued at the limit");
  // it never goes past it again, whatever happens
  for (let k = 0; k < 500; k++) { m.px = n.px = Infinity; m.px = SW.maxPx(m); n.px = SW.maxPx(n); SW.stepBy(w, 300, { keep: new Set([mk]) }); for (const i of Object.values(w.insts)) if (!(i.px <= SW.maxPx(i))) throw new Error(i.key + " " + i.px); }
  // Whale mode: huge buys
  const g = cheated(); g.cash = 1e12; g.memeMax = SW.MEME_MAX_PX;
  C.setToggle(g, "whale", true, T0); C.setToggle(g, "zeroFees", true, T0);
  E.executeBuy(g, MEME, 1e9, { px: 1, liq: 1000, t: T0 }, T0); near(E.whaleMult(g, MEME.key), 1.25, "25% per trade");
  for (let k = 0; k < 60; k++) E.executeBuy(g, MEME, 1e6, { px: 1, liq: 1000, t: T0 }, T0);
  near(E.gameQuote(g, MEME.key, { px: 1 }).px, 1000, "many buys stop at the limit"); eq(E.gameQuote(g, MEME.key, { px: 900 }).px, 1000, "also when the Sim price rises");
  E.executeSell(g, MEME.key, 0.5, { px: 1, liq: 1000, t: T0 }, T0); near(E.gameQuote(g, MEME.key, { px: 1 }).px, 750, "a sale lowers it from there");
});

await test("Levels · Billionaires, Countries, World: each cap unlocks the next; ties by time; badges survive", () => {
  eq(RICH.LEVELS.length, 3); ok(RICH.LEVELS.every((l, i, a) => !i || l.cap > a[i - 1].cap), "rising caps");
  eq(RICH.COUNTRIES[0][1], "United States"); eq(RICH.LEVELS[1].cap, RICH.COUNTRIES[0][2], "up to the US"); near(RICH.WORLD_WEALTH, 517.69e12, "UBS");
  ok(RICH.COUNTRIES.every((r, i, a) => !i || r[2] <= a[i - 1][2]), "sorted"); eq(RICH.ladder(5.1e12, RICH.COUNTRIES).place, 3, "country ladder");
  const s = E.newPortfolio(T0, 100000), none = () => null;
  eq(E.checkLevel(s, T0, none), -1, "nothing yet");
  for (let l = 0; l < 3; l++) {
    E.addCash(s, 1e15); near(s.cash, RICH.LEVELS[l].cap, "stops at level " + l, 1e-12);
    eq(E.checkLevel(s, T0 + l, none), l, "reached " + l); eq(E.checkLevel(s, T0 + 100, none), -1, "only once"); eq(s.reached[l], T0 + l, "when");
  }
  eq(s.level, 2); E.addCash(s, 1e15); near(s.cash, RICH.WORLD_WEALTH, "the last one is final", 1e-12); eq(s.reached[2], T0 + 2, "the first time counts");
  s.cash = 5; eq(RICH.levelOf(s), 2, "losing money keeps the level");
  // same cap: the first one wins, whatever the order
  const at = t => { const p = E.newPortfolio(T0, 100000); p.cash = 1e15; E.capCash(p); E.checkLevel(p, t, none); return standing(p, none); };
  const a = { id: "a", ...at(T0 + 50) }, b = { id: "b", ...at(T0 + 10) }, low = { id: "low", ...standing(E.newPortfolio(T0, 100000), none) };
  deepEq([a, low, b].sort(byRank).map(x => x.id), ["b", "a", "low"], "first to arrive"); deepEq([b, a, low].sort(byRank).map(x => x.id), ["b", "a", "low"], "any order");
  // badges: kept by the repair and by an import
  const A1 = { ...newAchievements(), prestige: [{ t: T0 }, { t: T0 + 1 }, { t: NaN }] }, is = [];
  CLEAN.cleanAchievements(A1, T0, is); eq(A1.prestige.length, 2, "only the damaged one goes"); eq(is.length, 1);
  eq(mergeAchievements(newAchievements(), A1).prestige.length, 2, "imported"); eq(mergeAchievements(A1, newAchievements()).prestige.length, 2, "never lost");
  const bad = E.newPortfolio(T0, 100000); bad.level = 9; bad.reached = [NaN]; CLEAN.cleanPortfolio(bad, T0, []); ok(bad.level === 0 && !bad.reached.length, "bad level repaired");
});

const pass = results.filter(r => r[0]).length;
document.getElementById("results").innerHTML = results.map(r => `<span class="${r[0] ? "pass" : "fail"}">${r[0] ? "PASS" : "FAIL"}</span> ${r[1]}${r[0] ? "" : "\n       → " + r[2]}`).join("\n");
document.getElementById("summary").innerHTML = `<b class="${pass === results.length ? "pass" : "fail"}">${pass}/${results.length} pass</b>`;
document.title = `DONE ${pass}/${results.length}`;
await destroyStore("ghost-desk-unittest");
