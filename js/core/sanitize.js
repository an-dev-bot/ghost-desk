// Saved data checks. Each function repairs a value in place and adds a line to `issues` for every thing it had to
// change; everything that is fine stays as it was. Used when the app loads and again before every save, so one bad
// number (NaN, Infinity, absurdly big) never costs the rest of the data.

import * as E from "./engine.js";
import { START_CASH } from "./money.js";
import { validBots } from "./bots.js";
import { newAchievements } from "./achievements.js";

const HUGE = 1e100;
export const num = n => typeof n === "number" && isFinite(n) && Math.abs(n) < HUGE;
const obj = x => !!x && typeof x === "object" && !Array.isArray(x);

/** Replace every bad number inside x (any depth) with `to`. Returns how many there were. */
export function scrub(x, to = null) {
  let n = 0;
  if (!x || typeof x !== "object") return 0;
  for (const k in x) {
    const v = x[k];
    if (typeof v === "number") { if (!num(v)) { x[k] = to; n++; } }
    else if (v && typeof v === "object") n += scrub(v, to);
  }
  return n;
}

/** Cash worked out again from the starting balance and the history. */
function cashFromTrades(p) {
  let c = p.start;
  for (const t of p.trades) c += t.side === "buy" ? -t.usd : t.usd;
  return Math.min(E.WORLD_CAP, Math.max(0, num(c) ? c : 0));
}

/** Returns the repaired portfolio, or null when there is nothing usable in it. */
export function cleanPortfolio(p, now, issues) {
  if (!obj(p)) { issues.push("the portfolio couldn't be read"); return null; }
  if (!E.validStart(p.start)) { issues.push("starting balance"); p.start = START_CASH; }
  for (const k of ["pos", "margin", "days"]) if (!obj(p[k])) { if (p[k] != null) issues.push(k); p[k] = {}; }
  for (const k of ["orders", "trades"]) if (!Array.isArray(p[k])) { issues.push(k); p[k] = []; }

  const trades = p.trades.filter(t => obj(t) && num(t.t) && typeof t.key === "string" && t.m && (t.side === "buy" || t.side === "sell"));
  if (trades.length !== p.trades.length) { issues.push(`${p.trades.length - trades.length} damaged trades in the history`); p.trades = trades; }
  const fixedTrades = p.trades.filter(t => {
    let n = scrub(t, 0);
    for (const k of ["qty", "px", "usd", "fee"]) if (!num(t[k])) { t[k] = 0; n++; }
    return n > 0;
  }).length;
  if (fixedTrades) issues.push(`numbers in ${fixedTrades} trades of the history`);

  if (p.cash === Infinity || (typeof p.cash === "number" && p.cash >= HUGE)) { issues.push("cash was over the money cap"); p.cash = E.WORLD_CAP; }
  else if (!num(p.cash)) { p.cash = cashFromTrades(p); issues.push("cash, worked out again from your history"); }

  for (const group of ["pos", "margin"]) {
    for (const k in p[group]) {
      const x = p[group][k];
      const good = obj(x) && x.inst?.m && typeof x.key === "string" && num(x.qty) && num(x.cost) && (group === "pos" || (num(x.lev) && num(x.avg) && (x.dir === 1 || x.dir === -1)));
      if (!good) {
        const back = num(x?.cost) && x.cost > 0 ? x.cost : 0;
        p.cash += back;
        delete p[group][k];
        issues.push(`position ${x?.inst?.sym || k}${back ? " (what it cost went back to cash)" : ""}`);
        continue;
      }
      let n = scrub(x);
      if (group === "pos" && !num(x.avg)) { x.avg = x.qty > 0 ? x.cost / x.qty : 0; n++; }
      if (!num(x.openedAt)) { x.openedAt = now; n++; }
      if (x.minRatio == null) x.minRatio = 1;
      if (n) issues.push(`numbers in position ${x.inst.sym || k}`);
    }
  }
  const orders = p.orders.filter(o => obj(o) && o.inst?.m && typeof o.key === "string" && (o.side === "buy" ? num(o.amount) : num(o.frac)) && (o.type !== "limit" || num(o.limit)));
  if (orders.length !== p.orders.length) { issues.push(`${p.orders.length - orders.length} waiting orders`); p.orders = orders; }
  for (const k in p.days) if (!obj(p.days[k]) || !num(p.days[k].first) || !num(p.days[k].last)) { delete p.days[k]; issues.push(`day ${k}`); }

  if (p.cheats !== undefined) {
    const c = p.cheats;
    if (!obj(c)) { delete p.cheats; issues.push("cheats"); }
    else {
      let n = 0;
      for (const k of ["on", "armed", "whale", "used"]) if (!obj(c[k])) { c[k] = {}; n++; }
      if (!Array.isArray(c.log)) { c.log = []; n++; }
      if (!num(c.lev) || c.lev < 1) { c.lev = 1; n++; }
      const b = c.boost;
      if (b && !(num(b.from) && num(b.until) && num(b.basePx) && num(b.lastPx))) { c.boost = null; n++; }
      for (const k in c.whale) if (!(num(c.whale[k]) && c.whale[k] > 0)) { delete c.whale[k]; n++; }
      n += scrub(c);
      if (n) issues.push("cheats");
    }
  }
  if (p.undo && scrub(p.undo)) { p.undo = null; issues.push("the last Undo"); }
  if (p.capCut !== undefined && !num(p.capCut)) { p.capCut = 0; issues.push("money cap"); }
  if (!num(p.seq)) { p.seq = 0; issues.push("trade counter"); }
  for (const t of p.trades) if (t.id > p.seq) p.seq = t.id;
  for (const o of p.orders) if (o.id > p.seq) p.seq = o.id;
  if (!num(p.createdAt)) p.createdAt = now;
  return p;
}

export function cleanBots(list, now, issues) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push("the rival bots"); return []; }
  return list.filter(b => {
    const mine = [];
    const pf = obj(b) ? cleanPortfolio(b.pf, now, mine) : null;
    if (!pf || !validBots([b])) { issues.push(`rival bot ${b?.name || "?"}`); return false; }
    if (!num(b.lastBuy)) b.lastBuy = 0;
    if (!num(b.seed)) { b.seed = now % 2147483647; mine.push("seed"); }
    for (const m of mine) issues.push(`${b.name}: ${m}`);
    return true;
  });
}

/** Saved settings on top of the defaults; a value of the wrong kind goes back to its default. */
export function cleanSettings(saved, def, issues) {
  if (saved == null) return structuredClone(def);
  if (!obj(saved)) { issues.push("settings"); return structuredClone(def); }
  const merge = (s, d, name) => {
    const out = { ...s };
    for (const k in d) {
      const v = s[k];
      if (v === undefined) out[k] = structuredClone(d[k]);
      else if (obj(d[k])) { if (obj(v)) out[k] = merge(v, d[k], name + k + "."); else { out[k] = structuredClone(d[k]); issues.push("setting " + name + k); } }
      else if (Array.isArray(d[k]) !== Array.isArray(v) || typeof v !== typeof d[k] || (typeof v === "number" && !num(v))) { out[k] = structuredClone(d[k]); issues.push("setting " + name + k); }
    }
    return out;
  };
  const out = merge(saved, def, "");
  const al = out.alerts.filter(a => obj(a) && typeof a.key === "string" && num(a.price));
  if (al.length !== out.alerts.length) { issues.push(`${out.alerts.length - al.length} price alerts`); out.alerts = al; }
  return out;
}

export function cleanAchievements(a, now, issues) {
  if (a == null) return newAchievements();
  if (!obj(a)) { issues.push("achievements"); return newAchievements(); }
  if (!obj(a.unlocked)) { a.unlocked = {}; issues.push("achievements"); }
  for (const k in a.unlocked) if (!num(a.unlocked[k])) { a.unlocked[k] = now; issues.push(`date of achievement ${k}`); }
  if (!obj(a.lifetime)) { a.lifetime = { trades: 0, markets: {} }; issues.push("achievement counters"); }
  if (!num(a.lifetime.trades)) { a.lifetime.trades = 0; issues.push("achievement counters"); }
  if (!obj(a.lifetime.markets)) a.lifetime.markets = {};
  return a;
}

/** Sim records: {wins, combo, jackpot, rug, streak}. A damaged record is cleared, the others stay. */
export function cleanRecords(r, def, issues) {
  if (r == null) return def;
  if (!obj(r)) { issues.push("Sim records"); return def; }
  if (!num(r.wins)) { r.wins = 0; issues.push("Sim win streak"); }
  for (const k of ["combo", "jackpot", "rug", "streak"]) if (r[k] != null && (!obj(r[k]) || scrub(r[k]))) { r[k] = null; issues.push(`Sim record ${k}`); }
  return r;
}

const goodBar = b => Array.isArray(b) && num(b[0]) && num(b[1]) && num(b[2]) && num(b[3]) && num(b[4]);

/** fresh(): a new world, only built when something has to be replaced. Returns null when the world is unusable. */
export function cleanWorld(w, fresh, issues) {
  if (!obj(w) || !num(w.t) || !obj(w.insts) || !obj(w.cur) || !Array.isArray(w.memes)) { issues.push("the Sim market (a new one was made)"); return null; }
  let nw = null;
  const F = () => (nw ||= fresh());
  if (!num(w.rs)) { w.rs = F().rs; issues.push("Sim market numbers"); }
  if (!num(w.evr?.rs)) { w.evr = F().evr; issues.push("Sim market numbers"); }
  for (const [k, d] of [["nextEventAt", w.t + 45e3], ["nextCoinAt", w.t + 3e3], ["coinN", Object.keys(w.insts).length], ["off", 0]]) if (!num(w[k])) { w[k] = d; issues.push("Sim market numbers"); }
  if (w.event && scrub(w.event)) { w.event = null; issues.push("Sim event"); }
  for (const c in w.cur) if (!(num(w.cur[c]?.usd) && w.cur[c].usd > 0) || scrub(w.cur[c])) { w.cur[c] = F().cur[c]; issues.push(`Sim currency ${c}`); }
  for (const k in w.insts) {
    const i = w.insts[k];
    let ok = obj(i) && num(i.px) && i.px > 0 && Array.isArray(i.b1) && Array.isArray(i.bh) && Array.isArray(i.bd);
    if (ok) for (const f in i) if (typeof i[f] === "number" && !num(i[f])) ok = false;
    if (ok) {
      let cut = 0;
      for (const f of ["b1", "bh", "bd"]) if (!i[f].every(goodBar)) { i[f] = i[f].filter(goodBar); cut++; }
      if (cut) issues.push(`Sim candles of ${i.sym}`);
      continue;
    }
    const rep = F().insts[k];
    if (rep && i?.m !== "meme") w.insts[k] = rep; else delete w.insts[k];
    issues.push(`Sim price of ${i?.sym || k}`);
  }
  w.memes = w.memes.filter(k => w.insts[k]);
  return w;
}
