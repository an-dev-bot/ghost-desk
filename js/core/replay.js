// Time machine: replay a past day on real 1-minute candles, in a separate replay portfolio.
// Pure: the app loads the candles and drives the clock; the tests pass hand-made bars.
//
// Only the past: the day has to be before today, and the replay clock never goes past the last real candle.
// The price at replay time t is the close of the last finished 1-minute candle: nothing is made up between candles.

import * as E from "./engine.js";
import * as H from "./hours.js";

export const SPEEDS = [0.25, 1, 10, 60];
export const PEEK = 5;            // Peek: the next 5 one-minute candles
export const DAYS_BACK = 7;       // days you can pick, before today
export const CONTEXT = 2 * 3600e3; // candles shown from before the day starts
const MIN = 60e3;

export function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** The days you can replay: yesterday back to DAYS_BACK days ago (local dates). */
export function replayDays(now) {
  const out = [];
  let d = startOfDay(now);
  for (let i = 0; i < DAYS_BACK; i++) {
    const prev = new Date(d); prev.setDate(prev.getDate() - 1); d = prev.getTime();
    out.push({ from: d, label: new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) });
  }
  return out;
}

/** Window of candles to load for a day: a bit of context before it, and up to 2 days after (for Time skip), never past now. */
export function loadWindow(day, now) {
  return { from: day - CONTEXT, to: Math.min(now, day + 2 * 86400e3) };
}

/** Forex pairs priced in another currency need that currency's rate; the replay only has this pair's candles. */
export function replayable(inst) {
  if (inst.m !== "fx") return true;
  return inst.quote === "USD" || inst.base === "USD";
}

export function newReplay({ inst, bars, day, start, now }) {
  if (!(day < startOfDay(now))) throw new E.TradeError("The Time machine only goes to the past: pick a day before today.");
  if (!replayable(inst)) throw new E.TradeError("This pair needs another currency's rate to value it. Pick a pair with USD.");
  bars = (bars || []).filter(b => b.c > 0 && b.t + MIN <= now).sort((a, b) => a.t - b.t);
  const first = bars.find(b => b.t >= day && b.t < day + 86400e3);
  if (!first || bars.filter(b => b.t >= day).length < PEEK + 2) throw new E.TradeError("No real candles for that day (the market was closed or nothing traded).");
  const pf = E.newPortfolio(now, start);
  pf.cheats = { on: {}, armed: {}, lev: 1, whale: {}, boost: null, log: [{ t: now, id: "timeMachine", text: "Time machine replay" }], used: { timeMachine: 1 }, since: now };
  return {
    inst, bars, day, t: first.t + 2 * MIN, end: bars[bars.length - 1].t + MIN,
    speed: 1, playing: false, peek: false, skips: 0, pf,
  };
}

export const visibleBars = rp => rp.bars.filter(b => b.t + MIN <= rp.t);
export const peekBars = rp => rp.bars.filter(b => b.t + MIN > rp.t).slice(0, PEEK);
export const atEnd = rp => rp.t >= rp.end;

/** Price at replay time: close of the last finished candle, with its time. */
export function priceNow(rp) {
  const v = visibleBars(rp);
  const b = v[v.length - 1];
  return b ? { px: b.c, t: b.t + MIN } : null;
}

/** Advance the replay clock by `realMs` of real time at the chosen speed. */
export function advance(rp, realMs) {
  if (!rp.playing) return false;
  rp.t = Math.min(rp.end, rp.t + realMs * rp.speed);
  if (atEnd(rp)) rp.playing = false;
  return true;
}

/** Time skip: jump ahead (1 hour or 1 day), never past the last real candle. */
export function skip(rp, ms) {
  rp.t = Math.min(rp.end, rp.t + ms);
  rp.skips++;
  return atEnd(rp);
}

export function quote(rp) {
  const p = priceNow(rp);
  if (!p) return null;
  const q = { px: p.px, t: p.t, liq: rp.inst.liq };
  if (rp.inst.m === "fx" && rp.inst.quote !== "USD") q.quoteUsd = 1 / p.px; // USD/xxx pairs
  return q;
}

/** Is the market open at replay time? (stocks: Wall Street hours of that day; forex: its week) */
export function marketOpen(rp) {
  return H.marketStatus(rp.inst.m, rp.t).open;
}

export function buy(rp, usd) {
  if (!marketOpen(rp)) throw new E.TradeError("The market was closed at this time of the replay.");
  return E.executeBuy(rp.pf, rp.inst, usd, quote(rp), rp.t, "replay", false, { tags: ["Time machine"] });
}
export function sell(rp) {
  if (!marketOpen(rp)) throw new E.TradeError("The market was closed at this time of the replay.");
  return E.executeSell(rp.pf, rp.inst.key, 1, quote(rp), rp.t, "replay", { tags: ["Time machine"] });
}
export function totals(rp) {
  const q = quote(rp);
  return E.totals(rp.pf, k => (k === rp.inst.key ? q : null));
}
