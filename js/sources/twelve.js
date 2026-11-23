// Twelve Data: candles for stocks and FX (free key: 8 credits/min, 800/day; reset at 00:00 UTC).
// The key goes in the Authorization header, never in the URL.
// Every series is saved on the phone and only asked for again when the cached one no longer covers the
// recent market (see cacheIsFresh); live prices keep extending it while the app is open.

import { getJSON, RateLimiter, SourceError } from "./http.js";
import { cacheIsFresh, mergeBars } from "../core/candles.js";

const BASE = "https://api.twelvedata.com";
const IVL = { "1m": "1min", "5m": "5min", "1h": "1h", "1d": "1day" };
export const DAILY_CAP = 790; // of 800, leave a little room

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * store: {get(k), set(k, v)} for the budget; cache: {get(k), set(k, v)} for candles.
 * Returns {bars, src:'twelvedata'|'cache', note} or throws SourceError.
 */
export function createTwelve({ getKey, budgetStore, cache, onError }) {
  const lim = new RateLimiter(7, 61e3);
  let budget = null;

  async function loadBudget(now) {
    if (!budget) budget = (await budgetStore.get("td.budget")) || { day: utcDay(now), used: 0, dayOut: false };
    if (budget.day !== utcDay(now)) budget = { day: utcDay(now), used: 0, dayOut: false };
    return budget;
  }
  async function spend(now) {
    const b = await loadBudget(now);
    b.used++;
    await budgetStore.set("td.budget", b);
  }

  async function status(now = Date.now()) {
    const b = await loadBudget(now);
    return { used: b.used, cap: DAILY_CAP, exhausted: b.dayOut || b.used >= DAILY_CAP, minuteFree: lim.free() };
  }

  async function fetchSeries(symbol, ivl, now) {
    const key = getKey();
    if (!key) throw new SourceError("twelvedata", "nokey", "Falta la clave de Twelve Data");
    const b = await loadBudget(now);
    if (b.dayOut || b.used >= DAILY_CAP) throw new SourceError("twelvedata", "limit", "Se acabaron las velas de hoy", 429, "day");
    if (lim.free() <= 0) throw new SourceError("twelvedata", "limit", "Espera un minuto para más velas", 429, "minute");
    await lim.take();
    await spend(now);
    const qs = new URLSearchParams({ symbol, interval: IVL[ivl], outputsize: "300", timezone: "UTC", order: "ASC" });
    let d;
    try {
      d = await getJSON(`${BASE}/time_series?${qs}`, { source: "twelvedata", headers: { Authorization: "apikey " + key } });
    } catch (e) { onError?.(e); throw e; }
    if (d?.status === "error") {
      const msg = String(d.message || "");
      let err;
      if (d.code === 401) err = new SourceError("twelvedata", "auth", "Twelve Data rechazó la clave", 401);
      else if (d.code === 429) {
        const day = /day|daily/i.test(msg);
        if (day) { b.dayOut = true; await budgetStore.set("td.budget", b); }
        err = new SourceError("twelvedata", "limit", day ? "Se acabaron las velas de hoy" : "Espera un minuto para más velas", 429, day ? "day" : "minute");
      } else if (d.code === 403) err = new SourceError("twelvedata", "premium", "Ese símbolo no viene en el plan gratis", 403);
      else err = new SourceError("twelvedata", "notfound", "Sin velas para ese símbolo", d.code || 400);
      onError?.(err);
      throw err;
    }
    const vals = d?.values || [];
    return vals.map(v => ({ t: Date.parse(v.datetime.length === 10 ? v.datetime + "T00:00:00Z" : v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
      .filter(x => x.c > 0 && isFinite(x.t)).sort((a, b) => a.t - b.t);
  }

  /**
   * Bars for symbol/interval. lastActive = when that market last produced prices.
   * Uses the phone's copy when it still covers the market; otherwise asks Twelve Data (1 credit).
   */
  async function series(symbol, ivl, { now = Date.now(), lastActive = now } = {}) {
    const ck = `td:${symbol}:${ivl}`;
    const cached = await cache.get(ck);
    if (cacheIsFresh(cached, ivl, lastActive)) return { bars: cached.bars, src: "cache" };
    try {
      const bars = await fetchSeries(symbol, ivl, now);
      const merged = mergeBars(cached?.bars, bars);
      await cache.set(ck, { bars: merged, fetchedAt: now });
      return { bars: merged, src: "twelvedata" };
    } catch (e) {
      if (cached?.bars?.length) return { bars: cached.bars, src: "cache", stale: true, error: e };
      throw e;
    }
  }

  /** Save live-extended bars back to the phone so the next open doesn't spend a credit. */
  async function saveLive(symbol, ivl, bars) {
    if (!bars?.length) return;
    const ck = `td:${symbol}:${ivl}`;
    const cached = await cache.get(ck);
    await cache.set(ck, { bars: mergeBars(cached?.bars, bars), fetchedAt: cached?.fetchedAt || Date.now() });
  }

  return { series, saveLive, status, hasKey: () => !!getKey(), _fetchSeries: fetchSeries };
}

/** Twelve Data symbol for an instrument. */
export function tdSymbol(inst) {
  if (inst.m === "fx") return inst.base + "/" + inst.quote;
  return inst.id;
}
