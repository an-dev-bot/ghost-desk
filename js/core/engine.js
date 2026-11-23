// Portfolio engine: one USD wallet, positions, pending orders, trade history.
// Pure state transitions (they mutate the state object passed in and return what happened),
// so the same code runs in the app and in the tests with hand-made prices.
//
// Quotes passed in are q = {px, t, liq?, quoteUsd?}: px the live mid/last price, t when that price was
// produced (ms). Market state is mkt = {open, since}: an order only fills while the market is open and
// with a price produced after the current session started (stocks wait for the opening bell).

import { START_CASH, START_MIN, START_MAX, quoteBuy, quoteSell, markValue } from "./money.js";

export class TradeError extends Error {}

export function newPortfolio(now = Date.now(), start = START_CASH) {
  if (!validStart(start)) throw new TradeError(`The starting balance must be between ${money(START_MIN)} and ${money(START_MAX)}.`);
  start = Math.round(start * 100) / 100;
  return { v: 1, start, cash: start, pos: {}, orders: [], trades: [], days: {}, createdAt: now, seq: 0 };
}
export function validStart(n) {
  return typeof n === "number" && isFinite(n) && n >= START_MIN && n <= START_MAX;
}
const money = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Only what is needed to value and re-quote an instrument later (stored inside positions/orders). */
export function slimInst(i) {
  const o = { key: i.key, m: i.m, id: i.id, sym: i.sym, name: i.name };
  for (const k of ["img", "base", "quote", "pair", "born"]) if (i[k] != null && i[k] !== "") o[k] = i[k];
  return o;
}

export function reserved(s) {
  return s.orders.reduce((a, o) => a + (o.side === "buy" ? o.amount : 0), 0);
}
export function available(s) {
  return Math.max(0, s.cash - reserved(s));
}

const EPS = 1e-9;

export function executeBuy(s, inst, usd, q, now, reason = "manual", fromOrder = false) {
  if (!(usd > 0)) throw new TradeError("The amount must be greater than zero.");
  const limit = fromOrder ? s.cash : available(s);
  if (usd > limit + EPS) throw new TradeError("Not enough cash: you have " + money(limit) + " available.");
  const r = quoteBuy(inst, usd, q);
  if (!r) throw new TradeError("No live price to trade with.");
  let p = s.pos[inst.key];
  if (!p) {
    p = s.pos[inst.key] = { key: inst.key, inst: slimInst(inst), qty: 0, cost: 0, avg: 0, sl: null, tp: null, openedAt: now, minRatio: 1, lastPx: q.px, lastT: q.t ?? now, lastQu: q.quoteUsd ?? null };
  }
  p.avg = (p.avg * p.qty + r.eff * r.qty) / (p.qty + r.qty);
  p.qty += r.qty;
  p.cost += usd;
  s.cash -= usd;
  if (Math.abs(s.cash) < EPS) s.cash = 0;
  const tr = {
    id: ++s.seq, t: now, key: inst.key, m: inst.m, sym: inst.sym, name: inst.name, side: "buy",
    qty: r.qty, px: r.eff, mid: q.px, usd, fee: r.fee, slip: r.slip, reason,
  };
  if (inst.m === "meme" && inst.born) tr.bornAgo = now - inst.born;
  s.trades.push(tr);
  return tr;
}

export function executeSell(s, key, frac, q, now, reason = "manual") {
  const p = s.pos[key];
  if (!p) throw new TradeError("You don't hold this position.");
  if (frac > 0.9999) frac = 1;
  const r = quoteSell(p.inst, p, frac, q);
  if (!r) throw new TradeError("No live price to sell at.");
  p.qty -= r.qty;
  p.cost -= r.costPart;
  s.cash += r.proceeds;
  const tr = {
    id: ++s.seq, t: now, key, m: p.inst.m, sym: p.inst.sym, name: p.inst.name, side: "sell",
    qty: r.qty, px: r.eff, mid: q.px, usd: r.proceeds, fee: r.fee, slip: r.slip,
    pl: r.pl, plPct: r.plPct, cost: r.costPart, held: now - p.openedAt, dip: 1 - p.minRatio, reason,
  };
  s.trades.push(tr);
  if (frac === 1 || p.qty <= EPS) {
    delete s.pos[key];
    s.orders = s.orders.filter(o => !(o.key === key && o.side === "sell"));
  }
  return tr;
}

/**
 * Place an order. spec = {side:'buy'|'sell', type:'market'|'limit', amount (USD, buys), frac (0..1, sells), limit (price)}.
 * Market orders fill now when the market is open; otherwise they wait for the open.
 * Returns {trade} or {order}.
 */
export function placeOrder(s, inst, spec, q, now, mkt) {
  const { side, type } = spec;
  if (side === "buy") {
    if (!(spec.amount > 0)) throw new TradeError("The amount must be greater than zero.");
    if (spec.amount > available(s) + EPS) throw new TradeError("Not enough cash: you have " + money(available(s)) + " available.");
  } else {
    if (!s.pos[inst.key]) throw new TradeError("You don't hold this position.");
    if (!(spec.frac > 0 && spec.frac <= 1)) throw new TradeError("Choose how much to sell.");
  }
  if (type === "limit" && !(spec.limit > 0)) throw new TradeError("Set the limit price.");
  if (type === "market" && mkt.open && !(q?.px > 0)) throw new TradeError("No live price to trade with.");
  if (type === "market" && mkt.open) {
    const trade = side === "buy" ? executeBuy(s, inst, spec.amount, q, now) : executeSell(s, inst.key, spec.frac, q, now);
    return { trade };
  }
  const order = {
    id: ++s.seq, key: inst.key, inst: slimInst(inst), side, type, createdAt: now,
    amount: side === "buy" ? spec.amount : undefined,
    frac: side === "sell" ? spec.frac : undefined,
    limit: type === "limit" ? spec.limit : undefined,
  };
  s.orders.push(order);
  return { order };
}

export function cancelOrder(s, id) {
  const before = s.orders.length;
  s.orders = s.orders.filter(o => o.id !== id);
  return s.orders.length !== before;
}

export function setStops(s, key, { sl, tp }) {
  const p = s.pos[key];
  if (!p) throw new TradeError("You don't hold this position.");
  if (sl !== undefined) p.sl = sl > 0 ? sl : null;
  if (tp !== undefined) p.tp = tp > 0 ? tp : null;
  return p;
}

/**
 * Check pending orders, stop loss and take profit for one instrument against a live price.
 * Called on every price update and when the app opens (so a price that already passed still fills).
 * Returns events: {type:'fill'|'cancel'|'sl'|'tp', order?, trade?, reason?}.
 */
export function checkKey(s, key, q, now, mkt) {
  const events = [];
  if (!(q?.px > 0)) return events;
  const p0 = s.pos[key];
  if (p0) {
    p0.lastPx = q.px; p0.lastT = q.t ?? now;
    if (q.quoteUsd) p0.lastQu = q.quoteUsd;
    const v = markValue(p0.inst, p0, q);
    if (v != null && p0.cost > 0) p0.minRatio = Math.min(p0.minRatio ?? 1, v / p0.cost);
  }
  if (!mkt.open) return events;
  const fresh = (q.t ?? now) >= (mkt.since || 0);
  if (!fresh) return events;

  for (const o of s.orders.filter(o => o.key === key)) {
    let hit;
    if (o.type === "market") hit = true;
    else if (o.side === "buy") hit = q.px <= o.limit;
    else hit = q.px >= o.limit;
    if (!hit) continue;
    s.orders = s.orders.filter(x => x.id !== o.id);
    const reason = o.type === "limit" ? "limit" : "open";
    try {
      const trade = o.side === "buy"
        ? executeBuy(s, o.inst, Math.min(o.amount, s.cash), q, now, reason, true)
        : executeSell(s, key, o.frac, q, now, reason);
      events.push({ type: "fill", order: o, trade });
    } catch (e) {
      events.push({ type: "cancel", order: o, reason: e.message });
    }
  }

  const p = s.pos[key];
  if (p) {
    if (p.sl != null && q.px <= p.sl) events.push({ type: "sl", trade: executeSell(s, key, 1, q, now, "sl") });
    else if (p.tp != null && q.px >= p.tp) events.push({ type: "tp", trade: executeSell(s, key, 1, q, now, "tp") });
  }
  return events;
}

/** Total portfolio value. quoteFor(key) → live quote or null (falls back to the last stored price). */
export function totals(s, quoteFor) {
  let held = 0, stale = 0;
  for (const key in s.pos) {
    const p = s.pos[key];
    let q = quoteFor?.(key);
    if (!(q?.px > 0)) { q = { px: p.lastPx, quoteUsd: p.lastQu }; stale++; }
    const v = markValue(p.inst, p, q);
    held += v == null ? p.cost : v;
  }
  const total = s.cash + held;
  return { cash: s.cash, held, total, pl: total - s.start, plPct: (total - s.start) / s.start, reserved: reserved(s), stale };
}

/** Value of a position plus unrealized P&L. */
export function positionView(p, q) {
  const qq = q?.px > 0 ? q : { px: p.lastPx, quoteUsd: p.lastQu };
  const value = markValue(p.inst, p, qq);
  const pl = value == null ? null : value - p.cost;
  return { value, pl, plPct: pl == null || !p.cost ? null : pl / p.cost, live: q?.px > 0 };
}

/** Record the portfolio value for today (local date), for "today" and the daily summary. */
export function recordDay(s, dateKey, total, now) {
  const d = (s.days[dateKey] ||= { first: total, firstT: now, last: total, lastT: now });
  d.last = total; d.lastT = now;
  const keys = Object.keys(s.days).sort();
  while (keys.length > 120) delete s.days[keys.shift()];
  return d;
}
