// Portfolio engine: one USD wallet, positions, pending orders, trade history.
// Pure state transitions (they mutate the state object passed in and return what happened),
// so the same code runs in the app and in the tests with hand-made prices.
//
// Quotes passed in are q = {px, t, liq?, quoteUsd?}: px the live mid/last price, t when that price was
// produced (ms). Market state is mkt = {open, since}: an order only fills while the market is open and
// with a price produced after the current session started (stocks wait for the opening bell).
//
// Cheats live in s.cheats (see cheats.js). A portfolio without s.cheats (every bot) trades with the plain
// rules: real costs, no leverage, no shields. The owner's portfolio sets s.undoable so Undo can step back.

import {
  START_CASH, START_MIN, START_MAX, quoteBuy, quoteSell, markValue, memeImpact,
  quoteOpenMargin, quoteCloseMargin, marginEquity, quoteToUsd,
} from "./money.js";
import { localDay } from "./stats.js";

export class TradeError extends Error {}

export function newPortfolio(now = Date.now(), start = START_CASH) {
  if (!validStart(start)) throw new TradeError(`The starting balance must be between ${money(START_MIN)} and ${money(START_MAX)}.`);
  start = Math.round(start * 100) / 100;
  return { v: 1, start, cash: start, pos: {}, margin: {}, orders: [], trades: [], days: {}, createdAt: now, seq: 0 };
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
export const SHIELD = 0.8;            // Rug shield: a position keeps at least 80% of what it cost
export const BOOST_X = 3;             // Moon boost: gains count 3x
export const MAGIC_NEAR = 0.005;      // Magic limit: fills when the price comes within 0.5%

// ---------------------------------------------------------------- cheat helpers
const on = s => s.cheats?.on || {};
const armed = s => s.cheats?.armed || {};
const costMods = s => ({ zeroFees: !!on(s).zeroFees, marketMaker: !!on(s).marketMaker });
function tag(t, name) { (t.cheat ||= []); if (!t.cheat.includes(name)) t.cheat.push(name); }
function logCheat(s, id, text, now) { if (!s.cheats) return; s.cheats.log.push({ t: now, id, text }); if (s.cheats.log.length > 300) s.cheats.log.shift(); }
export const isCheated = s => !!s?.cheats?.since;

/** Whale mode: your own memecoin buys have pushed this coin's price up, only inside your game. */
export function whaleMult(s, key) {
  const c = s.cheats;
  return c?.on?.whale && c.whale?.[key] > 0 ? c.whale[key] : 1;
}
export function gameQuote(s, key, q) {
  const m = s ? whaleMult(s, key) : 1;
  return m === 1 || !q ? q : { ...q, px: q.px * m };
}
function pushWhale(s, inst, usd, liq, dir) {
  if (!on(s).whale || inst.m !== "meme") return 0;
  const imp = memeImpact(usd, liq);
  const m = s.cheats.whale[inst.key] || 1;
  s.cheats.whale[inst.key] = dir > 0 ? m * (1 + imp) : m * (1 - imp);
  if (Math.abs(s.cheats.whale[inst.key] - 1) < 1e-9) delete s.cheats.whale[inst.key];
  return imp;
}

/** Moon boost: extra value (2 × the gain since it started, so the gain counts 3x) at the last price seen in its window. */
export function boostExtra(s, p) {
  const b = s?.cheats?.boost;
  if (!b || b.key !== p.key || p.lev || !(b.lastPx > b.basePx)) return 0;
  return (BOOST_X - 1) * p.qty * (b.lastPx - b.basePx);
}

// ---------------------------------------------------------------- undo (one step)
function snap(s) {
  if (!s.undoable) return;
  // Only what a trade can use up comes back with an undo (armed cheats, whale prices, the boost); switches stay as they are.
  const c = s.cheats;
  const cheats = c ? { armed: c.armed, whale: c.whale, boost: c.boost, secondDay: c.secondDay } : null;
  s.undo = structuredClone({ cash: s.cash, pos: s.pos, margin: s.margin || {}, orders: s.orders, seq: s.seq, cheats, erased: [] });
}
/** Step back to just before the last trade. Returns the trades that were undone. */
export function undoLast(s) {
  const u = s.undo;
  if (!u) throw new TradeError("Nothing to undo.");
  const gone = s.trades.filter(t => t.id > u.seq);
  s.trades = s.trades.filter(t => t.id <= u.seq).concat(u.erased).sort((a, b) => a.id - b.id);
  s.cash = u.cash; s.pos = u.pos; s.margin = u.margin; s.orders = u.orders;
  if (u.cheats && s.cheats) Object.assign(s.cheats, u.cheats);
  s.undo = null;
  return gone;
}
/** Cash that arrives outside a trade (Money printer, Moon boost payout) survives an undo. */
export function addCash(s, usd) {
  s.cash += usd;
  if (s.undo) s.undo.cash += usd;
}

// ---------------------------------------------------------------- buy / sell
/**
 * opts: {price: fill price chosen by a cheat (Golden entry, Sniper), tags: [cheat names], free: true (Airdrop)}
 */
export function executeBuy(s, inst, usd, q, now, reason = "manual", fromOrder = false, opts = {}) {
  if (opts.free) return freeBuy(s, inst, usd, q, now, opts);
  if (!(usd > 0)) throw new TradeError("The amount must be greater than zero.");
  const limit = fromOrder ? s.cash : available(s);
  if (usd > limit + EPS) throw new TradeError("Not enough cash: you have " + money(limit) + " available.");
  const q0 = opts.price > 0 && q ? { ...q, px: opts.price } : q;
  const gq = gameQuote(s, inst.key, q0);
  const mods = costMods(s);
  const r = quoteBuy(inst, usd, gq, mods);
  if (!r) throw new TradeError("No live price to trade with.");
  snap(s);
  const plain = mods.zeroFees || mods.marketMaker ? quoteBuy(inst, usd, gq) : r;
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
    qty: r.qty, px: r.eff, mid: gq.px, usd, fee: r.fee, slip: r.slip, reason,
  };
  if (inst.m === "meme" && inst.born) tr.bornAgo = now - inst.born;
  for (const n of opts.tags || []) tag(tr, n);
  if (plain.fee + plain.slip - r.fee - r.slip > 1e-9) tag(tr, mods.zeroFees ? "Zero fees" : "Market maker");
  if (gq !== q0) tag(tr, "Whale mode");
  if (pushWhale(s, inst, usd, q.liq, 1) > 0) tag(tr, "Whale mode");
  attachGhost(s, p, tr);
  s.trades.push(tr);
  return tr;
}

/** Airdrop: tokens worth `usd` at the live price, for free (cost 0). */
function freeBuy(s, inst, usd, q, now, opts) {
  if (!(q?.px > 0) || !(usd > 0)) throw new TradeError("No live price for the airdrop.");
  snap(s);
  const qty = usd / q.px;
  let p = s.pos[inst.key];
  if (!p) p = s.pos[inst.key] = { key: inst.key, inst: slimInst(inst), qty: 0, cost: 0, avg: 0, sl: null, tp: null, openedAt: now, minRatio: 1, lastPx: q.px, lastT: q.t ?? now, lastQu: null };
  p.avg = p.avg * p.qty / (p.qty + qty);
  p.qty += qty;
  const tr = { id: ++s.seq, t: now, key: inst.key, m: inst.m, sym: inst.sym, name: inst.name, side: "buy", qty, px: 0, mid: q.px, usd: 0, worth: usd, fee: 0, slip: 0, reason: "airdrop" };
  for (const n of opts.tags || []) tag(tr, n);
  s.trades.push(tr);
  return tr;
}

/**
 * Cheats that change what a sale pays: Moon boost, Rug shield, 2x Lucky trade, Insurance.
 * r = the plain quote {proceeds, costPart, ...}; returns tags applied. Mutates r.
 */
function saleCheats(s, p, r, frac) {
  const tags = [];
  if (!s.cheats) return tags;
  const extra = boostExtra(s, p) * frac;
  if (extra > 0) { r.proceeds += extra; tags.push("Moon boost"); }
  if (on(s).rugShield && r.costPart > 0 && r.proceeds < SHIELD * r.costPart) { r.proceeds = SHIELD * r.costPart; tags.push("Rug shield"); }
  let pl = r.proceeds - r.costPart;
  if (armed(s).lucky && pl > 0) { r.proceeds += pl; s.cheats.armed.lucky = false; tags.push("2x Lucky trade"); }
  else if (armed(s).insurance && pl < 0) { r.proceeds += -pl * 0.5; s.cheats.armed.insurance = false; tags.push("Insurance"); }
  r.pl = r.proceeds - r.costPart;
  r.plPct = r.costPart > 0 ? r.pl / r.costPart : 0;
  return tags;
}

/** opts: {price: fill price chosen by a cheat (Perfect exit), tags} */
export function executeSell(s, key, frac, q, now, reason = "manual", opts = {}) {
  const p = s.pos[key];
  if (!p) throw new TradeError("You don't hold this position.");
  if (frac > 0.9999) frac = 1;
  const q0 = opts.price > 0 && q ? { ...q, px: opts.price } : q;
  const gq = gameQuote(s, key, q0);
  const mods = costMods(s);
  const r = quoteSell(p.inst, p, frac, gq, mods);
  if (!r) throw new TradeError("No live price to sell at.");
  snap(s);
  const plain = mods.zeroFees || mods.marketMaker ? quoteSell(p.inst, p, frac, gq) : r;
  const tags = [...(opts.tags || [])];
  if (r.proceeds - plain.proceeds > 1e-9) tags.push(mods.zeroFees ? "Zero fees" : "Market maker");
  if (gq !== q0) tags.push("Whale mode");
  tags.push(...saleCheats(s, p, r, frac));
  pushWhale(s, p.inst, r.qty * q0.px, q.liq, -1);
  p.qty -= r.qty;
  p.cost -= r.costPart;
  s.cash += r.proceeds;
  const tr = {
    id: ++s.seq, t: now, key, m: p.inst.m, sym: p.inst.sym, name: p.inst.name, side: "sell",
    qty: r.qty, px: r.eff, mid: gq.px, usd: r.proceeds, fee: r.fee, slip: r.slip,
    pl: r.pl, plPct: r.plPct, cost: r.costPart, held: now - p.openedAt, dip: 1 - p.minRatio, reason,
  };
  for (const n of tags) tag(tr, n);
  s.trades.push(tr);
  const closed = frac === 1 || p.qty <= EPS;
  if (closed) {
    delete s.pos[key];
    s.orders = s.orders.filter(o => !(o.key === key && o.side === "sell"));
    if (s.cheats?.boost?.key === key) s.cheats.boost = null;
  }
  settleGhost(s, p, tr, closed, now);
  return tr;
}

// ---------------------------------------------------------------- Ghost trade
function attachGhost(s, p, tr) {
  if (!p.ghost && armed(s).ghost) { p.ghost = { ids: [], pl: 0 }; s.cheats.armed.ghost = false; }
  if (p.ghost) { p.ghost.ids.push(tr.id); tag(tr, "Ghost trade"); }
}
/** When a ghosted position closes at a loss, its trades are erased and the cash comes back. */
function settleGhost(s, p, tr, closed, now) {
  if (!p.ghost) return;
  p.ghost.ids.push(tr.id); p.ghost.pl += tr.pl;
  tag(tr, "Ghost trade");
  if (!closed) return;
  if (p.ghost.pl < 0) {
    const ids = new Set(p.ghost.ids);
    const gone = s.trades.filter(t => ids.has(t.id));
    if (s.undo) s.undo.erased.push(...gone.filter(t => t.id <= s.undo.seq).map(t => structuredClone(t)));
    s.trades = s.trades.filter(t => !ids.has(t.id));
    s.cash += -p.ghost.pl;
    tr.ghosted = -p.ghost.pl;
    logCheat(s, "ghost", `Ghost trade: a ${money(-p.ghost.pl)} loss on ${p.inst.sym} was erased`, now);
  }
}

// ---------------------------------------------------------------- leverage and shorts (margin positions)
export const marginPositions = s => Object.values(s.margin || {});

/** Open margin × lev, long (dir 1) or short (dir -1), at the live price, with the same costs on the full size. */
export function openMargin(s, inst, margin, lev, dir, q, now, reason = "manual", opts = {}) {
  if (!(margin > 0)) throw new TradeError("The amount must be greater than zero.");
  if (margin > available(s) + EPS) throw new TradeError("Not enough cash: you have " + money(available(s)) + " available.");
  if (!(lev >= 1) || (dir !== 1 && dir !== -1)) throw new TradeError("Choose the leverage.");
  const q0 = opts.price > 0 && q ? { ...q, px: opts.price } : q;
  const gq = gameQuote(s, inst.key, q0);
  const mods = costMods(s);
  const r = quoteOpenMargin(inst, margin, lev, dir, gq, mods);
  if (!r) throw new TradeError("No live price to trade with.");
  snap(s);
  s.margin ||= {};
  const id = "x" + (s.seq + 1);
  const p = s.margin[id] = {
    id, key: inst.key, inst: slimInst(inst), lev, dir, qty: r.qty, cost: margin, avg: r.eff, entryFee: r.fee,
    openedAt: now, minRatio: 1, lastPx: q.px, lastT: q.t ?? now, lastQu: q.quoteUsd ?? null,
  };
  s.cash -= margin;
  if (Math.abs(s.cash) < EPS) s.cash = 0;
  const tr = {
    id: ++s.seq, t: now, key: inst.key, m: inst.m, sym: inst.sym, name: inst.name, side: "buy", dir, lev, pos: id,
    qty: r.qty, px: r.eff, mid: gq.px, usd: margin, size: r.notional, fee: r.fee, slip: r.slip, reason,
  };
  if (lev > 1) tag(tr, `Leverage ${lev}x`);
  if (dir === -1 && (inst.m === "meme" || lev === 1)) tag(tr, "Short anything");
  for (const n of opts.tags || []) tag(tr, n);
  if (mods.zeroFees || mods.marketMaker) {
    const plain = quoteOpenMargin(inst, margin, lev, dir, gq);
    if (plain.fee + plain.slip - r.fee - r.slip > 1e-9) tag(tr, mods.zeroFees ? "Zero fees" : "Market maker");
  }
  if (pushWhale(s, inst, r.notional, q.liq, dir) > 0 || gq !== q0) tag(tr, "Whale mode");
  attachGhost(s, p, tr);
  s.trades.push(tr);
  return tr;
}

/** Close `frac` of a margin position. reason 'liq' = liquidation (the margin is lost). */
export function closeMargin(s, id, frac, q, now, reason = "manual", opts = {}) {
  const p = s.margin?.[id];
  if (!p) throw new TradeError("You don't hold this position.");
  if (frac > 0.9999) frac = 1;
  const q0 = opts.price > 0 && q ? { ...q, px: opts.price } : q;
  const gq = gameQuote(s, p.key, q0);
  const mods = costMods(s);
  const r = reason === "liq"
    ? { qty: p.qty, eff: gq.px, fee: 0, slip: 0, proceeds: 0, costPart: p.cost, pl: -p.cost, plPct: -1 }
    : quoteCloseMargin(p.inst, p, frac, gq, mods, !!on(s).diamond);
  if (!r) throw new TradeError("No live price to close at.");
  if (reason === "liq") frac = 1;
  snap(s);
  const tags = [...(opts.tags || [])];
  if (p.lev > 1) tags.push(`Leverage ${p.lev}x`);
  if (p.dir === -1 && (p.inst.m === "meme" || p.lev === 1)) tags.push("Short anything");
  if (reason !== "liq" && (mods.zeroFees || mods.marketMaker)) {
    const plain = quoteCloseMargin(p.inst, p, frac, gq, {}, !!on(s).diamond);
    if (r.proceeds - plain.proceeds > 1e-9) tags.push(mods.zeroFees ? "Zero fees" : "Market maker");
  }
  if (on(s).diamond && r.proceeds < 0) tags.push("Diamond hands");
  tags.push(...saleCheats(s, p, r, frac));
  pushWhale(s, p.inst, r.qty * q0.px * quoteToUsd(p.inst, q0), q.liq, -p.dir);
  p.qty -= r.qty;
  p.cost -= r.costPart;
  p.entryFee = (p.entryFee || 0) * (1 - frac);
  s.cash += r.proceeds;
  const tr = {
    id: ++s.seq, t: now, key: p.key, m: p.inst.m, sym: p.inst.sym, name: p.inst.name, side: "sell", dir: p.dir, lev: p.lev, pos: id,
    qty: r.qty, px: r.eff, mid: gq.px, usd: r.proceeds, fee: r.fee, slip: r.slip,
    pl: r.pl, plPct: r.plPct, cost: r.costPart, held: now - p.openedAt, dip: 1 - p.minRatio, reason,
  };
  for (const n of tags) tag(tr, n);
  s.trades.push(tr);
  const closed = frac === 1 || p.qty <= EPS;
  if (closed) delete s.margin[id];
  settleGhost(s, p, tr, closed, now);
  return tr;
}

/** Liquidation price: where the position's equity reaches 0 (null when no conversion rate is known). */
export function liqPrice(p, q) {
  const qu = quoteToUsd(p.inst, q || { quoteUsd: p.lastQu });
  if (!(qu > 0)) return null;
  return p.avg - p.dir * (p.cost - (p.entryFee || 0)) / (p.qty * qu);
}

// ---------------------------------------------------------------- orders
/**
 * Place an order. spec = {side:'buy'|'sell', type:'market'|'limit', amount (USD, buys), frac (0..1, sells), limit (price)}.
 * Market orders fill now when the market is open; otherwise they wait for the open.
 * Returns {trade} or {order}.
 */
export function placeOrder(s, inst, spec, q, now, mkt, opts = {}) {
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
    const trade = side === "buy" ? executeBuy(s, inst, spec.amount, q, now, "manual", false, opts) : executeSell(s, inst.key, spec.frac, q, now, "manual", opts);
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
 * Check pending orders, stop loss, take profit and liquidations for one instrument against a live price.
 * Called on every price update and when the app opens (so a price that already passed still fills).
 * Returns events: {type:'fill'|'cancel'|'sl'|'tp'|'liq'|'saved', order?, trade?, reason?, pos?}.
 */
export function checkKey(s, key, q, now, mkt) {
  const events = [];
  if (!(q?.px > 0)) return events;
  const p0 = s.pos[key];
  if (p0) {
    p0.lastPx = q.px; p0.lastT = q.t ?? now;
    if (q.quoteUsd) p0.lastQu = q.quoteUsd;
    const v = markValue(p0.inst, p0, gameQuote(s, key, q));
    if (v != null && p0.cost > 0) p0.minRatio = Math.min(p0.minRatio ?? 1, v / p0.cost);
  }
  const b = s.cheats?.boost;
  if (b && b.key === key && now <= b.until && (q.t ?? now) >= b.from) b.lastPx = q.px * whaleMult(s, key);
  for (const p of marginPositions(s)) {
    if (p.key !== key) continue;
    p.lastPx = q.px; p.lastT = q.t ?? now;
    if (q.quoteUsd) p.lastQu = q.quoteUsd;
    const v = markValue(p.inst, p, gameQuote(s, key, q));
    if (v != null && p.cost > 0) p.minRatio = Math.min(p.minRatio ?? 1, v / p.cost);
  }
  if (!mkt.open) return events;
  const fresh = (q.t ?? now) >= (mkt.since || 0);
  if (!fresh) return events;

  const magic = !!on(s).magicLimit;
  for (const o of s.orders.filter(o => o.key === key)) {
    let hit, near = false;
    if (o.type === "market") hit = true;
    else if (o.side === "buy") { hit = q.px <= o.limit; near = !hit && magic && q.px <= o.limit * (1 + MAGIC_NEAR); }
    else { hit = q.px >= o.limit; near = !hit && magic && q.px >= o.limit * (1 - MAGIC_NEAR); }
    if (!hit && !near) continue;
    s.orders = s.orders.filter(x => x.id !== o.id);
    const reason = o.type === "limit" ? "limit" : "open";
    // Magic limit: the price only came close, and the order fills at the limit price anyway.
    const opts = near ? { price: o.limit, tags: ["Magic limit"] } : {};
    try {
      const trade = o.side === "buy"
        ? executeBuy(s, o.inst, Math.min(o.amount, s.cash), q, now, reason, true, opts)
        : executeSell(s, key, o.frac, q, now, reason, opts);
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

  // Liquidation: when the loss reaches the margin. Diamond hands and Rug shield skip it; Second chance saves it once a day.
  for (const m of marginPositions(s)) {
    if (m.key !== key) continue;
    const gq = gameQuote(s, key, q);
    const qu = quoteToUsd(m.inst, gq);
    if (!(qu > 0)) continue;
    if (marginEquity(m, gq.px, qu) > 0 || on(s).diamond || on(s).rugShield) continue;
    const day = localDay(now);
    if (on(s).secondChance && s.cheats.secondDay !== day) {
      s.cheats.secondDay = day;
      m.avg = gq.px; m.entryFee = 0; m.qty = m.cost * m.lev / (gq.px * qu); m.minRatio = 1;
      logCheat(s, "secondChance", `Second chance: ${m.inst.sym} ${m.lev}x ${m.dir > 0 ? "long" : "short"} got its ${money(m.cost)} margin back at ${gq.px.toPrecision(6)}`, now);
      events.push({ type: "saved", pos: m });
      continue;
    }
    events.push({ type: "liq", trade: closeMargin(s, m.id, 1, q, now, "liq") });
  }
  return events;
}

// ---------------------------------------------------------------- valuation
/** Value of one position (spot or margin) for this portfolio, with its cheats. null when there is no price at all. */
export function positionValue(s, p, q) {
  const qq = q?.px > 0 ? q : { px: p.lastPx, quoteUsd: p.lastQu };
  let v = markValue(p.inst, p, gameQuote(s, p.key, qq));
  if (v == null) return null;
  if (s?.cheats) {
    v += boostExtra(s, p);
    if (s.cheats.on?.rugShield && p.cost > 0) v = Math.max(v, SHIELD * p.cost);
  }
  return v;
}

/** Total portfolio value. quoteFor(key) → live quote or null (falls back to the last stored price). */
export function totals(s, quoteFor) {
  let held = 0, stale = 0;
  for (const p of [...Object.values(s.pos), ...marginPositions(s)]) {
    const q = quoteFor?.(p.key);
    if (!(q?.px > 0)) stale++;
    const v = positionValue(s, p, q);
    held += v == null ? p.cost : v;
  }
  const total = s.cash + held;
  return { cash: s.cash, held, total, pl: total - s.start, plPct: (total - s.start) / s.start, reserved: reserved(s), stale };
}

/** Value of a position plus unrealized P&L. Pass the portfolio to include its cheats. */
export function positionView(p, q, s = null) {
  const value = positionValue(s, p, q);
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
