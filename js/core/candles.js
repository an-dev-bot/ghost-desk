// Candle helpers: bars are [{t, o, h, l, c}] ascending, t = bar start (ms, UTC).

export const INTERVALS = { "1m": 60e3, "5m": 300e3, "1h": 3600e3, "1d": 86400e3 };

/** Fold one live price into the series (updates the current bar or opens a new one). Mutates bars. */
export function applyTick(bars, ivl, t, px, max = 500) {
  if (!(px > 0)) return bars;
  const ms = INTERVALS[ivl];
  const start = Math.floor(t / ms) * ms;
  const last = bars[bars.length - 1];
  if (last && start < last.t) return bars; // older than what we have
  if (last && last.t === start) {
    last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px;
  } else {
    bars.push({ t: start, o: last ? last.c : px, h: Math.max(px, last ? last.c : px), l: Math.min(px, last ? last.c : px), c: px });
    if (bars.length > max) bars.splice(0, bars.length - max);
  }
  return bars;
}

/** Build bars from recorded live prices [{t, px}] (the fallback when no candle source is available). */
export function ticksToBars(ticks, ivl) {
  const bars = [];
  for (const k of ticks) applyTick(bars, ivl, k.t, k.px);
  if (bars[0]) bars[0].o = ticks[0].px;
  return bars;
}

/**
 * Is a cached series still good enough to skip asking the source again?
 * lastActive = when the market last produced prices (now while open, the last close otherwise).
 */
const TOLERANCE = { "1m": 15 * 60e3, "5m": 40 * 60e3, "1h": 3 * 3600e3, "1d": 36 * 3600e3 };
export function cacheIsFresh(entry, ivl, lastActive) {
  if (!entry?.bars?.length) return false;
  const last = entry.bars[entry.bars.length - 1];
  const end = last.t + INTERVALS[ivl];
  return lastActive - end <= TOLERANCE[ivl];
}

/** Merge two ascending series, newer values win on equal timestamps. */
export function mergeBars(a, b, max = 500) {
  const m = new Map();
  for (const x of a || []) m.set(x.t, x);
  for (const x of b || []) m.set(x.t, x);
  const out = [...m.values()].sort((x, y) => x.t - y.t);
  return out.length > max ? out.slice(out.length - max) : out;
}
