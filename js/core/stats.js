// Scoreboards, streaks and CSV, all derived from the real trade history.

const pad = n => String(n).padStart(2, "0");
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function prevDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return localDay(new Date(y, m - 1, d - 1, 12).getTime());
}

export const MARKET_LABEL = { meme: "Memecoins", crypto: "Crypto", stock: "Stocks", fx: "Forex" };

/** Per market and overall: closed trades, win rate, total realized, best and worst trade. */
export function scoreboard(trades) {
  const blank = () => ({ n: 0, wins: 0, total: 0, best: null, worst: null, winRate: null, volume: 0 });
  const out = { all: blank(), meme: blank(), crypto: blank(), stock: blank(), fx: blank() };
  for (const t of trades) {
    for (const b of [out.all, out[t.m]]) {
      if (!b) continue;
      b.volume += t.usd;
      if (t.side !== "sell") continue;
      b.n++;
      if (t.pl > 0) b.wins++;
      b.total += t.pl;
      if (!b.best || t.pl > b.best.pl) b.best = t;
      if (!b.worst || t.pl < b.worst.pl) b.worst = t;
    }
  }
  for (const k in out) out[k].winRate = out[k].n ? out[k].wins / out[k].n : null;
  return out;
}

export function realizedByDay(trades) {
  const m = {};
  for (const t of trades) if (t.side === "sell") m[localDay(t.t)] = (m[localDay(t.t)] || 0) + t.pl;
  return m;
}

/**
 * Days in a row closing green (realized profit of the day > 0), counting back from today.
 * A day that has not closed any trade yet does not break the streak until it is over.
 */
export function greenStreak(trades, now = Date.now()) {
  const sums = realizedByDay(trades);
  let day = localDay(now);
  if (sums[day] !== undefined && sums[day] <= 0) return 0;
  if (sums[day] === undefined) day = prevDay(day);
  let n = 0;
  while (sums[day] > 0) { n++; day = prevDay(day); }
  return n;
}

export function winStreak(trades) {
  let best = 0, cur = 0;
  for (const t of trades) {
    if (t.side !== "sell") continue;
    cur = t.pl > 0 ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

const REASON = { manual: "manual", limit: "limit order", open: "waiting order (market open)", sl: "stop loss", tp: "take profit" };

/** US format a spreadsheet reads as a date: 11/23/2026 4:05:09 PM (phone's local time). */
export function usDateTime(ms) {
  const d = new Date(ms), h = d.getHours();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

export function toCSV(trades) {
  const head = ["date", "market", "symbol", "name", "side", "quantity", "price", "amount_usd", "fee_usd", "slippage_usd", "pl_usd", "pl_pct", "reason"];
  const cell = v => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Token names come from the internet: never let a spreadsheet read them as formulas.
  const text = v => (/^[=+\-@\t\r]/.test(String(v ?? "")) ? "'" : "") + (v ?? "");
  const rows = trades.map(t => [
    usDateTime(t.t), MARKET_LABEL[t.m] || t.m, text(t.sym), text(t.name), t.side === "buy" ? "buy" : "sell",
    +t.qty.toPrecision(10), +t.px.toPrecision(10), t.usd.toFixed(2), (t.fee || 0).toFixed(4), (t.slip || 0).toFixed(4),
    t.side === "sell" ? t.pl.toFixed(2) : "", t.side === "sell" ? (t.plPct * 100).toFixed(2) : "", REASON[t.reason] || t.reason,
  ].map(cell).join(","));
  return "﻿" + [head.join(","), ...rows].join("\r\n") + "\r\n";
}
