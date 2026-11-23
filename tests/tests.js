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
import { newBot, step as botStep, freshQuotes, standing, botName, STYLE_IDS, MAX_AGE } from "../js/core/bots.js";

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
