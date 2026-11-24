// Sim mode extras: combo multiplier, jackpots and the Sim records table. Pure.

export const LADDER = [1, 2, 3, 5, 8, 13, 21, 34, 55, 100];
export const JACKPOT_X = 10;

/** Visual multiplier for n winning sales in a row: 1, x2, x3, x5, x8… */
export const comboMult = n => (n <= 0 ? 1 : LADDER[Math.min(n - 1, LADDER.length - 1)]);

export function newRecords() {
  return { v: 1, wins: 0, combo: null, jackpot: null, rug: null, streak: null };
}

/** A sale closed: the combo grows on a win and breaks on a loss. Returns {wins, mult, up, broke}. */
export function onSale(rec, t, now) {
  if (t.pl > 0) {
    rec.wins++;
    const mult = comboMult(rec.wins);
    if (!rec.combo || mult > rec.combo.x) rec.combo = { x: mult, n: rec.wins, t: now };
    if (!rec.streak || rec.wins > rec.streak.n) rec.streak = { n: rec.wins, t: now };
    return { wins: rec.wins, mult, up: mult > comboMult(rec.wins - 1), broke: false };
  }
  const broke = rec.wins >= 2;
  rec.wins = 0;
  return { wins: 0, mult: 1, up: false, broke };
}

/** A position reached JACKPOT_X its cost. Returns true when it beats the record. */
export function onJackpot(rec, { sym, mult, usd }, now) {
  if (rec.jackpot && rec.jackpot.mult >= mult) return false;
  rec.jackpot = { sym, mult, usd, t: now };
  return true;
}

/** A rug pull hit a coin you held: usd lost in that drop. Returns true when it's the worst so far. */
export function onRug(rec, { sym, usd, pct }, now) {
  if (rec.rug && rec.rug.usd >= usd) return false;
  rec.rug = { sym, usd, pct, t: now };
  return true;
}

/** Positions (spot or margin) that just reached the jackpot multiple. Marks them so each one counts once. */
export function newJackpots(positions, valueOf) {
  const out = [];
  for (const p of positions) {
    if (p.jackpot || !(p.cost > 0)) continue;
    const v = valueOf(p);
    if (v != null && v / p.cost >= JACKPOT_X) { p.jackpot = true; out.push({ p, mult: v / p.cost, usd: v - p.cost }); }
  }
  return out;
}
