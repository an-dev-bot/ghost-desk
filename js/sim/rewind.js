// Rewind (Sim only): save points of the Sim world, your Sim portfolio and the bots.
// A full copy every 15 minutes for a week would take gigabytes, so one point a day is complete ("key") and the
// others only hold what changed since the point before: the newest candles and trades. Pure module.

export const EVERY = 15 * 60e3;
export const KEEP = 7 * 86400e3 + 30 * 60e3;
export const KEY_EVERY = 96;                         // points between two complete ones (one day)
export const REWINDS = { "1m": 60e3, "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": 3600e3, "1d": 86400e3, "1w": 7 * 86400e3 };
// Short rewinds: the last 20 minutes also have a point every 20 seconds, each one built on the last main point.
export const FINE_EVERY = 20e3, FINE_KEEP = 20 * 60e3;
const SERIES = { b1: 360, bh: 240, bd: 120 };
const BOT_TRADES = 2000;

const pack = bars => { const a = new Float64Array(bars.length * 6); bars.forEach((b, i) => { for (let k = 0; k < 6; k++) a[i * 6 + k] = b[k] || 0; }); return a; };
const unpack = a => { const out = []; for (let i = 0; i < a.length; i += 6) out.push([a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]); return out; };
const flips = ts => ts.reduce((n, t) => n + (t.flip ? 1 : 0), 0);

/** Portfolio without its history, its Undo and its cheat log. */
function head(pf) {
  const { trades, undo, cheats, ...rest } = pf;
  return structuredClone({ ...rest, undo: null, ...(cheats ? { cheats: { ...cheats, log: [] } } : {}) });
}
function tradeDelta(pf, ref, trimmed) {
  const old = ref && ref.createdAt === pf.createdAt && pf.seq >= ref.seq &&
    (trimmed || (pf.trades.filter(t => t.id <= ref.seq).length === ref.n && flips(pf.trades.filter(t => t.id <= ref.seq)) === ref.flips));
  return { full: !old, list: structuredClone(old ? pf.trades.filter(t => t.id > ref.seq) : pf.trades) };
}

/** A point for this moment. prev: the point before it (null → a complete one). */
export function makePoint(w, s, bots, prev = null) {
  const insts = [];
  const last = prev && new Map(prev.insts.map(x => [x.head.key, x]));
  for (const k in w.insts) {
    const { b1, bh, bd, ...rest } = w.insts[k];
    const x = { head: structuredClone(rest), bars: {} }, p = last?.get(k);
    for (const f in SERIES) {
      const arr = w.insts[k][f], from = p?.bars[f]?.data.length ? p.bars[f].data[p.bars[f].data.length - 6] : null;
      x.bars[f] = { full: from == null, data: pack(from == null ? arr : arr.filter(b => b[0] >= from)) };
    }
    insts.push(x);
  }
  const { insts: _, ...world } = w;
  const tail = pf => ({ createdAt: pf.createdAt, seq: pf.seq, n: pf.trades.length, flips: flips(pf.trades) });
  return {
    t: w.t, key: !prev, n: prev ? prev.n + 1 : 0, world: structuredClone(world), insts,
    s: { head: head(s), trades: tradeDelta(s, prev?.s.tail, false), tail: tail(s) },
    bots: bots.map(b => {
      const p = prev?.bots.find(x => x.id === b.id), { pf, ...rest } = b;
      return { id: b.id, bot: structuredClone(rest), head: head(pf), trades: tradeDelta(pf, p?.tail, true), tail: tail(pf) };
    }),
  };
}

/** chain: the points from a complete one to the wanted one, in order. Returns {w, s, bots} as they were. */
export function restore(chain) {
  const bars = new Map(), botTrades = new Map();
  let trades = [];
  const join = (a, d) => (d.full ? d.list.slice() : a.concat(d.list));
  for (const p of chain) {
    for (const x of p.insts) {
      const b = bars.get(x.head.key) || {};
      for (const f in SERIES) {
        const d = unpack(x.bars[f].data);
        b[f] = x.bars[f].full || !b[f] ? d : b[f].filter(y => !d.length || y[0] < d[0][0]).concat(d).slice(-SERIES[f]);
      }
      bars.set(x.head.key, b);
    }
    trades = join(trades, p.s.trades);
    for (const b of p.bots) botTrades.set(b.id, join(botTrades.get(b.id) || [], b.trades).slice(-BOT_TRADES));
  }
  const end = chain[chain.length - 1];
  const w = { ...structuredClone(end.world), insts: {} };
  for (const x of end.insts) w.insts[x.head.key] = { ...structuredClone(x.head), ...bars.get(x.head.key) };
  return {
    w,
    s: { ...structuredClone(end.s.head), trades: structuredClone(trades) },
    bots: end.bots.map(b => ({ ...structuredClone(b.bot), pf: { ...structuredClone(b.head), trades: structuredClone(botTrades.get(b.id)) } })),
  };
}

/** The point to go back to: the newest one at or before `target`. index: [{t, key}]. Returns its position or -1. */
export function pointAt(index, target) {
  for (let i = index.length - 1; i >= 0; i--) if (index[i].t <= target) return i;
  return -1;
}
/** The points needed to rebuild number i: from the last complete one up to it. */
export function chainOf(index, i) {
  let k = i;
  while (k > 0 && !index[k].key) k--;
  return index.slice(k, i + 1);
}
/** Points too old to be needed (a complete one stays while a point of its day can still be used). */
export function expired(index, now) {
  let k = 0;
  index.forEach((p, i) => { if (p.key && p.t <= now - KEEP) k = i; });
  return index.slice(0, k);
}

/** What stays as it is now after a rewind: your switches, the cheat record (the star) and the bots' cheat logs. */
export function carryOver(back, s, bots, t) {
  const c = s.cheats;
  if (c) {
    const o = (back.s.cheats ||= { armed: {}, whale: {}, boost: null });
    for (const k of ["on", "lev", "always", "log", "used", "since"]) if (c[k] !== undefined) o[k] = structuredClone(c[k]);
  }
  for (const b of back.bots) {
    const now = bots.find(x => x.id === b.id);
    if (b.pf.cheats) b.pf.cheats.log = structuredClone((now?.pf.cheats?.log || []).filter(x => x.t <= t));
  }
  return back;
}
