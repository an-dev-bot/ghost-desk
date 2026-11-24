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
import { newBot, step as botStep, freshQuotes, standing, botName, STYLE_IDS, MAX_AGE, preview as botPreview } from "../js/core/bots.js";
import * as C from "../js/core/cheats.js";
import * as RP from "../js/core/replay.js";
import * as SW from "../js/sim/world.js";
import * as FUN from "../js/sim/fun.js";

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
  eq(C.CHEATS.length, 24, "24 cheats in the menu");
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
  const w2 = E.executeSell(e, BTC.key, 1, { px: 66000, t: T0 }, T0);
  C.doubleOrNothing(e, 0.7, T0 + 1);
  eq(w2.pl, 0, "tails: the profit is gone"); near(e.cash, 100000, "back to what it cost");
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

await test("Cheats · Moon boost, Airdrop once a day, Copycat; bots never cheat", () => {
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
  near(bt.fee, 6, "my Zero fees don't apply to the bot: it pays 0.1% on $6,000"); ok(!bot.pf.cheats && !bt.cheat, "the bot has no cheats");
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

await test("Cheats · achievements earned with cheats are kept apart", () => {
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
  const vol = i => { const b = i.b1.slice(-30); let a = 0; for (let k = 1; k < b.length; k++) a += Math.log(b[k][4] / b[k - 1][4]) ** 2; return Math.sqrt(a / (b.length - 1)); };
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
const pass = results.filter(r => r[0]).length;
document.getElementById("results").innerHTML = results.map(r => `<span class="${r[0] ? "pass" : "fail"}">${r[0] ? "PASS" : "FAIL"}</span> ${r[1]}${r[0] ? "" : "\n       → " + r[2]}`).join("\n");
document.getElementById("summary").innerHTML = `<b class="${pass === results.length ? "pass" : "fail"}">${pass}/${results.length} pass</b>`;
document.title = `DONE ${pass}/${results.length}`;
await destroyStore("ghost-desk-unittest");
