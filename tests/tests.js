// Spec tests 1–5 with hand-made prices (no network). Test 6 (375 px) lives in layout.html.
// Expected numbers were computed by hand, independently of the app code.

import * as E from "../js/core/engine.js";
import * as H from "../js/core/hours.js";
import { quoteBuy, quoteSell, markValue } from "../js/core/money.js";
import { scoreboard, greenStreak, toCSV, localDay } from "../js/core/stats.js";
import { newAchievements, evaluate } from "../js/core/achievements.js";
import { applyTick, cacheIsFresh, ticksToBars } from "../js/core/candles.js";
import { buildBackup, parseBackup, mergeAchievements, BackupError } from "../js/core/backup.js";
import { openStore, kv, destroyStore } from "../js/store.js";
import { setFetch } from "../js/sources/http.js";
import { createTwelve } from "../js/sources/twelve.js";
import { createFinnhub } from "../js/sources/stocks.js";
import { fxInst } from "../js/sources/fx.js";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e?.message || String(e)]); }
}
function ok(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: esperaba ${b}, salió ${a}`); }
function near(a, b, msg, rel = 1e-9) { if (!(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)))) throw new Error(`${msg}: esperaba ${b}, salió ${a}`); }
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
function deepEq(a, b, msg) { if (canon(a) !== canon(b)) throw new Error(msg + ": no son iguales"); }

const MEME = { key: "meme:GHST", m: "meme", id: "GHST", sym: "GHOST", name: "Ghost Coin", pair: "POOL1" };
const BTC = { key: "crypto:BTCUSDT", m: "crypto", id: "BTCUSDT", sym: "BTC", name: "Bitcoin" };
const AAPL = { key: "stock:AAPL", m: "stock", id: "AAPL", sym: "AAPL", name: "Apple" };
const EURUSD = fxInst("EURUSD"), USDJPY = fxInst("USDJPY");
const ALWAYS = { open: true, since: 0 };
const T0 = Date.UTC(2026, 10, 24, 15, 0); // Tue 24 Nov 2026, 10:00 New York

// ---------------------------------------------------------------- 1. buy and sell in every market
await test("1 · Memecoin: 1% de comisión + impacto por liquidez, compra y venta", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, MEME, 1000, { px: 0.001, liq: 100000, t: T0 }, T0);
  near(b.fee, 10, "comisión compra");
  near(b.px, 0.00102, "precio efectivo con 2% de impacto");
  near(b.qty, 970588.2352941176, "cantidad");
  near(s.cash, 9000, "efectivo");
  const v = E.executeSell(s, MEME.key, 1, { px: 0.0012, liq: 100000, t: T0 + 1 }, T0 + 1);
  near(v.fee, 11.375750865051902, "comisión venta", 1e-9);
  near(v.usd, 1126.1993356401383, "dinero recibido", 1e-9);
  near(v.pl, 126.19933564013832, "ganancia", 1e-9);
  near(s.cash, 10126.199335640138, "efectivo final", 1e-9);
  ok(!s.pos[MEME.key], "la posición se cerró");
});

await test("1 · Cripto: 0.1% de comisión + 0.02% de deslizamiento", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  near(b.fee, 1, "comisión compra"); near(b.px, 60012, "precio efectivo"); near(b.qty, 0.016646670665866826, "cantidad");
  const v = E.executeSell(s, BTC.key, 1, { px: 66000, t: T0 }, T0);
  near(v.px, 65986.8, "precio efectivo venta"); near(v.fee, 1.0984605278944213, "comisión venta", 1e-9);
  near(v.usd, 1097.3620673665266, "recibido", 1e-9); near(v.pl, 97.36206736652662, "ganancia", 1e-9);
});

await test("1 · Acciones: $0 de comisión, pagas medio diferencial", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  eq(b.fee, 0, "comisión"); near(b.px, 200.01, "precio efectivo"); near(b.qty, 4.9997500124993755, "cantidad (fraccionaria)");
  const v = E.executeSell(s, AAPL.key, 1, { px: 210, t: T0 }, T0);
  near(v.px, 209.9895, "precio efectivo venta"); near(v.usd, 1049.8950052497376, "recibido", 1e-9); near(v.pl, 49.89500524973755, "ganancia", 1e-9);
  near(quoteBuy(AAPL, 100, { px: 5 }).eff, 5.005, "acción barata: mínimo $0.01 de diferencial");
});

await test("1 · Divisas EURUSD: diferencial típico de 1 pip", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, EURUSD, 1000, { px: 1.1, quoteUsd: 1, t: T0 }, T0);
  near(b.px, 1.10005, "precio efectivo"); near(b.qty, 909.049588655061, "euros comprados", 1e-9);
  const v = E.executeSell(s, EURUSD.key, 1, { px: 1.12, quoteUsd: 1, t: T0 }, T0);
  near(v.usd, 1018.0900868142356, "recibido", 1e-9); near(v.pl, 18.090086814235633, "ganancia", 1e-9);
});

await test("1 · Divisas USDJPY: ganancia en yenes convertida a dólares", () => {
  const s = E.newPortfolio(T0);
  const b = E.executeBuy(s, USDJPY, 1000, { px: 150, quoteUsd: 1 / 150, t: T0 }, T0);
  near(b.px, 150.005, "precio efectivo"); near(b.qty, 999.9666677777408, "dólares en la posición", 1e-9);
  const v = E.executeSell(s, USDJPY.key, 1, { px: 155, quoteUsd: 1 / 155, t: T0 }, T0);
  near(v.usd, 1032.1924753045867, "recibido", 1e-9); near(v.pl, 32.19247530458665, "ganancia", 1e-9);
});

await test("1 · Venta parcial, comprar sin dinero y valor de la cartera", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 2000, { px: 50000, t: T0 }, T0);
  const v = E.executeSell(s, BTC.key, 0.5, { px: 50000, t: T0 }, T0);
  near(v.cost, 1000, "costo de la mitad");
  ok(s.pos[BTC.key] && Math.abs(s.pos[BTC.key].cost - 1000) < 1e-9, "queda la otra mitad");
  let threw = false;
  try { E.executeBuy(s, BTC, 1e6, { px: 50000, t: T0 }, T0); } catch (e) { threw = e instanceof E.TradeError; }
  ok(threw, "no deja comprar más del efectivo");
  const t = E.totals(s, () => ({ px: 50000 }));
  near(t.total, s.cash + s.pos[BTC.key].qty * 50000, "total = efectivo + posiciones");
});

// ---------------------------------------------------------------- 2. stocks wait for the open
const SAT = H.nyToUtc(2026, 11, 28, 12, 0);         // Saturday
const FRI_CLOSE_T = H.nyToUtc(2026, 11, 27, 12, 59); // last trade Friday (early close day)
const MON_OPEN = H.nyToUtc(2026, 11, 30, 9, 30);

await test("2 · Horario: 9:30–16:00 NY, feriados y cierre temprano", () => {
  const mon = H.stockStatus(Date.UTC(2026, 10, 23, 22, 11)); // Mon 17:11 NY
  ok(!mon.open && mon.reason === "post", "lunes 17:11 cerrado");
  eq(mon.nextOpen, Date.UTC(2026, 10, 24, 14, 30), "abre martes 9:30 NY (14:30 UTC)");
  const tg = H.stockStatus(H.nyToUtc(2026, 11, 26, 11, 0));
  ok(!tg.open && tg.reason === "holiday", "Acción de Gracias cerrado");
  eq(tg.nextOpen, H.nyToUtc(2026, 11, 27, 9, 30), "abre el viernes");
  const fri = H.stockStatus(H.nyToUtc(2026, 11, 27, 12, 0));
  ok(fri.open && fri.early, "viernes abierto con cierre temprano");
  eq(fri.closesAt, H.nyToUtc(2026, 11, 27, 13, 0), "cierra a las 13:00");
  ok(!H.stockStatus(H.nyToUtc(2026, 11, 27, 13, 30)).open, "13:30 ya cerró");
  eq(H.nyToUtc(2026, 3, 9, 9, 30), Date.UTC(2026, 2, 9, 13, 30), "horario de verano: 9:30 NY = 13:30 UTC");
  ok(H.stockStatus(H.nyToUtc(2026, 11, 24, 9, 30)).open && !H.stockStatus(H.nyToUtc(2026, 11, 24, 9, 29)).open, "abre justo a las 9:30");
});

await test("2 · Divisas: domingo 17:00 a viernes 17:00 NY", () => {
  ok(H.fxStatus(H.nyToUtc(2026, 11, 27, 16, 59)).open, "viernes 16:59 abierto");
  const fc = H.fxStatus(H.nyToUtc(2026, 11, 27, 17, 0));
  ok(!fc.open, "viernes 17:00 cerrado");
  eq(fc.nextOpen, H.nyToUtc(2026, 11, 29, 17, 0), "abre el domingo 17:00");
  ok(!H.fxStatus(H.nyToUtc(2026, 11, 29, 16, 59)).open && H.fxStatus(H.nyToUtc(2026, 11, 29, 17, 0)).open, "domingo 17:00 abre");
  eq(H.fxStatus(H.nyToUtc(2026, 11, 24, 3, 0)).closesAt, H.nyToUtc(2026, 11, 27, 17, 0), "cuenta regresiva al cierre del viernes");
});

await test("2 · Acciones: con el mercado cerrado la orden espera y se llena en la apertura", () => {
  const s = E.newPortfolio(SAT);
  const r = E.placeOrder(s, AAPL, { side: "buy", type: "market", amount: 1000 }, { px: 200, t: FRI_CLOSE_T }, SAT, H.marketStatus("stock", SAT));
  ok(r.order && !r.trade, "no se llenó en sábado");
  eq(s.cash, 10000, "el efectivo no se movió");
  eq(E.available(s), 9000, "pero el monto queda apartado");
  eq(E.checkKey(s, AAPL.key, { px: 195, t: SAT + 60e3 }, SAT + 60e3, H.marketStatus("stock", SAT + 60e3)).length, 0, "sábado: sigue esperando");
  const at = MON_OPEN + 5000;
  eq(E.checkKey(s, AAPL.key, { px: 201, t: FRI_CLOSE_T }, at, H.marketStatus("stock", at)).length, 0, "con el precio viejo del viernes no se llena");
  const ev = E.checkKey(s, AAPL.key, { px: 202, t: MON_OPEN + 2000 }, at, H.marketStatus("stock", at));
  eq(ev.length, 1, "se llenó al abrir"); eq(ev[0].type, "fill", "evento"); eq(ev[0].trade.reason, "open", "motivo");
  near(ev[0].trade.px, 202.0101, "con el primer precio real de la apertura (202 + medio diferencial de 0.0202)");
  eq(s.orders.length, 0, "ya no hay órdenes");
});

await test("2 · Venta de acciones y divisas fuera de horario también espera", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  E.executeBuy(s, EURUSD, 1000, { px: 1.1, quoteUsd: 1, t: T0 }, T0);
  E.placeOrder(s, AAPL, { side: "sell", type: "market", frac: 1 }, { px: 200, t: FRI_CLOSE_T }, SAT, H.marketStatus("stock", SAT));
  E.placeOrder(s, EURUSD, { side: "sell", type: "market", frac: 1 }, { px: 1.1, quoteUsd: 1, t: SAT }, SAT, H.marketStatus("fx", SAT));
  ok(s.pos[AAPL.key] && s.pos[EURUSD.key] && s.orders.length === 2, "las dos esperan");
  const sun = H.nyToUtc(2026, 11, 29, 17, 0) + 30e3;
  const ev = E.checkKey(s, EURUSD.key, { px: 1.11, quoteUsd: 1, t: sun }, sun, H.marketStatus("fx", sun));
  ok(ev[0]?.type === "fill" && !s.pos[EURUSD.key], "divisas se vende al abrir el domingo");
  ok(s.pos[AAPL.key], "la acción sigue esperando al lunes");
});

// ---------------------------------------------------------------- 3. limit, stop loss, take profit
await test("3 · Orden límite de compra: se llena al tocar el precio", () => {
  const s = E.newPortfolio(T0);
  const r = E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 1000, limit: 58000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  ok(r.order, "queda puesta");
  eq(E.checkKey(s, BTC.key, { px: 59000, t: T0 + 1 }, T0 + 1, ALWAYS).length, 0, "a 59,000 no");
  const ev = E.checkKey(s, BTC.key, { px: 57990, t: T0 + 2 }, T0 + 2, ALWAYS);
  eq(ev[0]?.type, "fill", "a 57,990 sí"); eq(ev[0].trade.reason, "limit", "motivo");
  near(ev[0].trade.px, 57990 * 1.0002, "con comisión y deslizamiento normales");
});

await test("3 · Al abrir la app con un precio que ya pasó, la orden se llena", () => {
  let s = E.newPortfolio(T0);
  E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 1000, limit: 58000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  s = JSON.parse(JSON.stringify(s)); // closed and reopened: state comes back from storage
  const ev = E.checkKey(s, BTC.key, { px: 50000, t: T0 + 3600e3 }, T0 + 3600e3, ALWAYS);
  eq(ev[0]?.type, "fill", "se llena con el precio actual"); near(ev[0].trade.mid, 50000, "al precio actual (mejor que el límite)");
});

await test("3 · Orden límite de venta parcial", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.placeOrder(s, BTC, { side: "sell", type: "limit", frac: 0.5, limit: 65000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  eq(E.checkKey(s, BTC.key, { px: 64000, t: T0 }, T0, ALWAYS).length, 0, "a 64,000 no");
  const q0 = s.pos[BTC.key].qty;
  const ev = E.checkKey(s, BTC.key, { px: 65100, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "fill", "a 65,100 sí"); near(s.pos[BTC.key].qty, q0 / 2, "vendió la mitad");
});

await test("3 · Stop loss y take profit, también con precio que brincó (gap)", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, BTC, 1000, { px: 60000, t: T0 }, T0);
  E.setStops(s, BTC.key, { sl: 55000, tp: 70000 });
  eq(E.checkKey(s, BTC.key, { px: 56000, t: T0 }, T0, ALWAYS).length, 0, "a 56,000 nada");
  const ev = E.checkKey(s, BTC.key, { px: 54000, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "sl", "stop loss activado"); ok(ev[0].trade.pl < 0, "con pérdida"); ok(!s.pos[BTC.key], "posición cerrada");
  near(ev[0].trade.px, 54000 * (1 - 0.0002), "vende al precio en vivo");
  const s2 = E.newPortfolio(T0);
  E.executeBuy(s2, MEME, 500, { px: 0.001, liq: 1e6, t: T0 }, T0);
  E.setStops(s2, MEME.key, { tp: 0.002 });
  const ev2 = E.checkKey(s2, MEME.key, { px: 0.0025, liq: 1e6, t: T0 }, T0, ALWAYS);
  eq(ev2[0]?.type, "tp", "take profit activado"); ok(ev2[0].trade.pl > 0, "con ganancia");
});

await test("3 · Stop loss de acciones: no se activa con el mercado cerrado, sí en la apertura", () => {
  const s = E.newPortfolio(T0);
  E.executeBuy(s, AAPL, 1000, { px: 200, t: T0 }, T0);
  E.setStops(s, AAPL.key, { sl: 190 });
  eq(E.checkKey(s, AAPL.key, { px: 180, t: SAT }, SAT, H.marketStatus("stock", SAT)).length, 0, "sábado: nada");
  const at = MON_OPEN + 1000;
  const ev = E.checkKey(s, AAPL.key, { px: 180, t: MON_OPEN + 500 }, at, H.marketStatus("stock", at));
  eq(ev[0]?.type, "sl", "lunes en la apertura se activa");
});

await test("3 · Orden que ya no alcanza se cancela con aviso", () => {
  const s = E.newPortfolio(T0);
  E.placeOrder(s, BTC, { side: "buy", type: "limit", amount: 10000, limit: 50000 }, { px: 60000, t: T0 }, T0, ALWAYS);
  s.cash = 0; // e.g. after an import
  const ev = E.checkKey(s, BTC.key, { px: 49000, t: T0 }, T0, ALWAYS);
  eq(ev[0]?.type, "cancel", "se cancela"); eq(s.orders.length, 0, "sin órdenes");
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
  E.recordDay(s, localDay(T0), 10012.5, T0);
  return s;
}

await test("4 · La cartera se guarda en IndexedDB y vuelve igual", async () => {
  await destroyStore("ghost-desk-unittest");
  ok(await openStore("ghost-desk-unittest"), "IndexedDB disponible");
  const s = sampleState();
  await kv.set("portfolio", s);
  deepEq(await kv.get("portfolio"), s, "guardada = leída");
});

await test("4 · Exportar e importar da la misma cartera (sin claves en el archivo)", async () => {
  const s = sampleState();
  const a = newAchievements();
  evaluate(a, s.trades, { trades: s.trades, total: 10000, now: T0 });
  const settings = { finnhubKey: "FAKEKEY_FH_0123456789", twelveKey: "FAKEKEY_TD_abcdef0123", sound: true, alerts: [] };
  const text = buildBackup({ portfolio: s, achievements: a, settings });
  ok(!text.includes("FAKEKEY"), "el archivo no lleva claves");
  const d = parseBackup(text);
  deepEq(d.portfolio, s, "cartera importada");
  deepEq(d.achievements, a, "logros importados");
  eq(d.settings.sound, true, "ajustes públicos importados");
  await kv.set("portfolio", d.portfolio);
  deepEq(await kv.get("portfolio"), s, "importada, guardada y leída");
  const val = k => E.totals(k, key => ({ [BTC.key]: { px: 61000 }, [MEME.key]: { px: 0.0011, liq: 2e5 }, [AAPL.key]: { px: 205 }, [USDJPY.key]: { px: 151, quoteUsd: 1 / 151 } }[key])).total;
  near(val(d.portfolio), val(s), "mismo valor total");
  let bad = false;
  try { parseBackup('{"app":"otra"}'); } catch (e) { bad = e instanceof BackupError; }
  ok(bad, "rechaza archivos que no son respaldos");
  const merged = mergeAchievements(newAchievements(), a);
  ok(merged.unlocked.first_trade === a.unlocked.first_trade, "los logros se fusionan");
});

await test("4 · Historial a CSV, sin fórmulas peligrosas", () => {
  const s = sampleState();
  s.trades[0].name = "=HYPERLINK(\"x\")";
  const csv = toCSV(s.trades);
  const lines = csv.trim().split("\r\n");
  eq(lines.length, s.trades.length + 1, "una fila por operación");
  ok(lines[0].includes("resultado_usd"), "encabezados");
  ok(csv.includes("'=HYPERLINK"), "nombre neutralizado");
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

await test("5 · Twelve Data: la clave va en la cabecera, nunca en la URL; las velas se guardan y no se repiden", async () => {
  const KEY = "FAKEKEY_TD_0123456789abcdef";
  const bars = [{ datetime: "2026-11-24 14:00:00", open: "200", high: "201", low: "199", close: "200.5" }, { datetime: "2026-11-24 15:00:00", open: "200.5", high: "202", low: "200", close: "201.5" }];
  const calls = mockFetch(() => [200, { values: bars, status: "ok" }]);
  const budget = memKV(), cache = memKV();
  const td = createTwelve({ getKey: () => KEY, budgetStore: budget, cache });
  const now = Date.UTC(2026, 10, 24, 16, 10);
  const r = await td.series("AAPL", "1h", { now, lastActive: now });
  eq(r.bars.length, 2, "velas"); eq(r.bars[1].t, Date.UTC(2026, 10, 24, 15, 0), "hora en UTC");
  eq(calls.length, 1, "una petición");
  ok(!calls[0].url.includes(KEY), "la clave no está en la URL");
  eq(calls[0].headers.Authorization, "apikey " + KEY, "va en la cabecera");
  const r2 = await td.series("AAPL", "1h", { now: now + 30 * 60e3, lastActive: now + 30 * 60e3 });
  eq(r2.src, "cache", "segunda vez sale del teléfono"); eq(calls.length, 1, "sin gastar otra petición");
  // weekend: Friday's copy still covers the market, no request
  const sat = H.nyToUtc(2026, 11, 28, 12, 0);
  await cache.set("td:AAPL:1h", { bars: [{ t: H.nyToUtc(2026, 11, 27, 12, 0), o: 1, h: 1, l: 1, c: 1 }], fetchedAt: sat - 3600e3 });
  const r3 = await td.series("AAPL", "1h", { now: sat, lastActive: H.lastStockActivity(sat) });
  eq(r3.src, "cache", "fin de semana: no se repiden"); eq(calls.length, 1, "sin peticiones");
  eq((await td.status(now)).used, 1, "contador de créditos del día");
  setFetch(null);
});

await test("5 · Twelve Data: al acabarse las 800 del día deja de pedir y lo dice", async () => {
  const calls = mockFetch(() => [200, { status: "error", code: 429, message: "You have run out of API credits for the day." }]);
  const td = createTwelve({ getKey: () => "FAKEKEY_TD_x1234567", budgetStore: memKV(), cache: memKV() });
  const now = Date.UTC(2026, 10, 24, 16, 0);
  let e1;
  try { await td.series("EUR/USD", "5m", { now, lastActive: now }); } catch (e) { e1 = e; }
  ok(e1?.kind === "limit" && e1.body === "day", "error de límite diario");
  let e2;
  try { await td.series("EUR/USD", "1m", { now, lastActive: now }); } catch (e) { e2 = e; }
  ok(e2?.kind === "limit", "sigue sin velas"); eq(calls.length, 1, "no volvió a pedir");
  ok((await td.status(now)).exhausted, "marcado como agotado");
  ok(!(await td.status(now + 86400e3)).exhausted, "al día siguiente se reinicia");
  setFetch(null);
});

await test("5 · Finnhub: clave rechazada da un error claro que no contiene la clave", async () => {
  const KEY = "FAKEKEY_FH_9876543210";
  mockFetch(() => [401, { error: "Invalid API key" }]);
  const seen = [];
  const fh = createFinnhub({ getKey: () => KEY, onError: e => seen.push(e) });
  let err;
  try { await fh.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "auth", "tipo de error");
  ok(!JSON.stringify({ m: err.message, b: err.body, s: err.source }).includes(KEY), "el error no lleva la clave");
  eq(seen.length, 1, "la app recibe el aviso");
  mockFetch(() => [429, { error: "API limit reached" }]);
  try { await fh.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "limit", "límite de peticiones");
  const noKey = createFinnhub({ getKey: () => "" });
  try { await noKey.quote("AAPL"); } catch (e) { err = e; }
  eq(err?.kind, "nokey", "sin clave");
  setFetch(null);
});

await test("5 · El service worker solo guarda archivos de la app y fuentes, nunca peticiones de precios", async () => {
  const sw = await (await fetch("../sw.js", { cache: "no-store" })).text();
  ok(/url\.origin === self\.location\.origin/.test(sw), "solo archivos propios");
  ok(/FONT_HOSTS = \["fonts\.googleapis\.com", "fonts\.gstatic\.com"\]/.test(sw), "más las fuentes");
  ok(!/finnhub|twelvedata/i.test(sw.replace(/\/\/.*$/gm, "")), "no toca las fuentes de precios");
  const app = await (await fetch("../js/app.js", { cache: "no-store" })).text();
  ok(!/localStorage|sessionStorage/.test(app), "las claves no van a localStorage");
});

// ---------------------------------------------------------------- extras: achievements, candles
await test("Logros: primera ganancia, +50%, sobrevivir a -30%, 4 mercados y racha", () => {
  const s = E.newPortfolio(T0);
  const a = newAchievements();
  const day = d => Date.UTC(2026, 10, d, 17, 0);
  E.executeBuy(s, MEME, 100, { px: 1, liq: 1e9, t: day(20) }, day(20));
  E.checkKey(s, MEME.key, { px: 0.65, liq: 1e9, t: day(20) }, day(20), ALWAYS); // fell 35%
  E.executeSell(s, MEME.key, 1, { px: 1.7, liq: 1e9, t: day(20) }, day(20));
  E.executeBuy(s, BTC, 100, { px: 100, t: day(21) }, day(21)); E.executeSell(s, BTC.key, 1, { px: 110, t: day(21) }, day(21));
  E.executeBuy(s, AAPL, 100, { px: 100, t: day(22) }, day(22)); E.executeSell(s, AAPL.key, 1, { px: 110, t: day(22) }, day(22));
  E.executeBuy(s, EURUSD, 100, { px: 1, quoteUsd: 1, t: day(22) }, day(22));
  const got = evaluate(a, s.trades, { trades: s.trades, total: 10100, now: day(22) });
  for (const id of ["first_trade", "first_win", "win_50", "survivor", "four_markets", "streak_3"]) ok(got.includes(id), "falta " + id);
  eq(greenStreak(s.trades, day(23)), 3, "racha de 3 días (el día en curso aún no la rompe)");
  const sb = scoreboard(s.trades);
  eq(sb.all.n, 3, "3 cerradas"); eq(sb.all.winRate, 1, "100% ganadoras"); eq(sb.meme.best.sym, "GHOST", "mejor por mercado");
});

await test("Velas: el precio en vivo mueve la última vela o abre una nueva", () => {
  const bars = [];
  applyTick(bars, "1m", 60000, 10); applyTick(bars, "1m", 90000, 12); applyTick(bars, "1m", 110000, 9);
  eq(bars.length, 1, "misma vela"); eq(bars[0].h, 12, "máximo"); eq(bars[0].l, 9, "mínimo"); eq(bars[0].c, 9, "cierre");
  applyTick(bars, "1m", 125000, 11);
  eq(bars.length, 2, "vela nueva"); eq(bars[1].o, 9, "abre donde cerró la anterior");
  eq(ticksToBars([{ t: 0, px: 1 }, { t: 300000, px: 2 }], "5m").length, 2, "de precios en vivo a velas");
  ok(cacheIsFresh({ bars: [{ t: 0 }] }, "1d", 86400e3 + 3600e3), "vela diaria reciente sirve");
  ok(!cacheIsFresh({ bars: [{ t: 0 }] }, "1m", 3600e3), "velas de 1m viejas no sirven");
});

// ---------------------------------------------------------------- report
const pass = results.filter(r => r[0]).length;
document.getElementById("results").innerHTML = results.map(r => `<span class="${r[0] ? "pass" : "fail"}">${r[0] ? "PASA " : "FALLA"}</span> ${r[1]}${r[0] ? "" : "\n       → " + r[2]}`).join("\n");
document.getElementById("summary").innerHTML = `<b class="${pass === results.length ? "pass" : "fail"}">${pass}/${results.length} pasan</b>`;
document.title = `DONE ${pass}/${results.length}`;
await destroyStore("ghost-desk-unittest");
