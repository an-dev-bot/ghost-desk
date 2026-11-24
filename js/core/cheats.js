// Cheats: the owner's menu of unfair advantages. Pure state changes on a portfolio's s.cheats. The bots arm
// their own (a shorter list, see bots.js) through the same state and the same engine rules.
//
// Any cheat that is turned on, armed or used marks the portfolio (s.cheats.since): the leaderboard and the
// history show a star, and achievements unlocked while it is marked are kept apart. Resetting the portfolio
// creates a clean one, so the mark goes away.

import * as E from "./engine.js";
import { localDay } from "./stats.js";

export const CHEATS = [
  { id: "printer", group: "Money", icon: "🖨️", name: "Money printer", desc: "Add $10K, $100K or $1M to your cash." },
  { id: "zeroFees", group: "Costs", icon: "🆓", name: "Zero fees", kind: "toggle", desc: "No commissions, spread, slippage or price impact." },
  { id: "marketMaker", group: "Costs", icon: "🏦", name: "Market maker", kind: "toggle", desc: "Your trades have no price impact (commissions still apply)." },
  { id: "leverage", group: "Trading", icon: "⚙️", name: "Leverage", desc: "10x, 50x or 100x on what you buy, long or short in crypto, stocks and forex. Liquidated for real when the loss reaches your margin." },
  { id: "shortAll", group: "Trading", icon: "🩳", name: "Short anything", kind: "toggle", desc: "Short every market, memecoins too, at your leverage (1x without it)." },
  { id: "magicLimit", group: "Trading", icon: "🪄", name: "Magic limit", kind: "toggle", desc: "Limit orders fill at your price when the live price comes within 0.5%." },
  { id: "whale", group: "Trading", icon: "🐋", name: "Whale mode", kind: "toggle", desc: "Your big memecoin buys push its price up, only inside your game (sells push it down), 25% per trade at most." },
  { id: "golden", group: "Next trade", icon: "🥇", name: "Golden entry", kind: "arm", desc: "Your next market buy fills at the lowest price of the last 15 minutes." },
  { id: "perfect", group: "Next trade", icon: "🎯", name: "Perfect exit", kind: "arm", desc: "Your next market sale fills at the highest price the coin touched today." },
  { id: "sniper", group: "Next trade", icon: "🔭", name: "Sniper", kind: "arm", desc: "Your next memecoin buy fills at the price of its first candle (real GeckoTerminal data)." },
  { id: "lucky", group: "Next trade", icon: "🍀", name: "2x Lucky trade", kind: "arm", desc: "Your next sale with a profit pays double the profit." },
  { id: "ghost", group: "Next trade", icon: "👻", name: "Ghost trade", kind: "arm", desc: "If the next position you open closes at a loss, it's erased as if it never happened." },
  { id: "insurance", group: "Next trade", icon: "☂️", name: "Insurance", kind: "arm", desc: "Get back 50% of your next loss." },
  { id: "don", group: "After a win", icon: "🪙", name: "Double or nothing", desc: "Flip a coin on your last winning sale: the profit doubles or it's gone." },
  { id: "undo", group: "After a trade", icon: "↩️", name: "Undo", desc: "Take back your last trade." },
  { id: "rugShield", group: "Protection", icon: "🛡️", name: "Rug shield", kind: "toggle", desc: "No position can lose more than 20%." },
  { id: "diamond", group: "Protection", icon: "💎", name: "Diamond hands", kind: "toggle", desc: "Leveraged positions are never liquidated (losses past the margin come out of your cash)." },
  { id: "secondChance", group: "Protection", icon: "❤️‍🩹", name: "Second chance", kind: "toggle", desc: "Once a day, a liquidation is reversed: you keep the position with its margin, from the current price." },
  { id: "moon", group: "Memecoins", icon: "🌙", name: "Moon boost", desc: "On a memecoin you hold, gains count 3x for 10 minutes." },
  { id: "airdrop", group: "Memecoins", icon: "🪂", name: "Airdrop", desc: "Once a day, a random memecoin for free." },
  { id: "timeMachine", group: "Time", icon: "⏪", name: "Time machine", desc: "Replay a past day on real 1-minute candles at 0.25x, 1x, 10x or 60x, with Peek at the next 5 minutes. Only the past." },
  { id: "timeSkip", group: "Time", icon: "⏩", name: "Time skip", desc: "In the Time machine, jump 1 hour or 1 day ahead and see where your positions stand." },
  { id: "oracle", group: "Time", icon: "🔮", name: "Oracle", kind: "toggle", desc: "Sim mode only: see the next 30 minutes of the coin you're viewing. The chart marks BUY at the best moment to enter and SELL = max profit at the peak, before it happens." },
  { id: "copycat", group: "Rivals", icon: "🐒", name: "Copycat", desc: "Copy the leading bot's portfolio into yours." },
  { id: "xray", group: "Rivals", icon: "🩻", name: "X-ray", kind: "toggle", desc: "See what each bot will buy before it does." },
];
export const CHEAT = Object.fromEntries(CHEATS.map(c => [c.id, c]));
export const PRINTER = [10000, 100000, 1000000];
export const LEVERAGE = [1, 10, 50, 100];
export const BOOST_MS = 10 * 60e3;
export const AIRDROP_SHARE = 0.01;   // an airdrop is worth 1% of your starting balance at the live price
export const DON_FLOOR = 100;        // Double or nothing lost: the whole portfolio drops to $100
/** One-shot cheats that can be set to "Always on": re-armed by themselves after every trade. */
export const ALWAYS = ["golden", "perfect", "sniper", "lucky", "ghost", "insurance", "don"];

export function state(s) {
  return (s.cheats ||= { on: {}, armed: {}, lev: 1, whale: {}, boost: null, log: [], used: {}, since: null });
}
export function mark(s, id, text, now) {
  const c = state(s);
  c.since ||= now;
  c.used[id] = (c.used[id] || 0) + 1;
  c.log.push({ t: now, id, text });
  if (c.log.length > 300) c.log.shift();
}
export const isOn = (s, id) => !!s.cheats?.on?.[id];
export const isAlways = (s, id) => !!s.cheats?.always?.[id];

/** Always on: the cheat is armed now and re-arms itself after every trade (Double or nothing asks after every win). */
export function setAlways(s, id, val, now) {
  if (!ALWAYS.includes(id)) throw new E.TradeError("This cheat can't be always on.");
  const c = state(s);
  (c.always ||= {})[id] = !!val;
  if (val) { if (CHEAT[id].kind === "arm") c.armed[id] = true; mark(s, id, `${CHEAT[id].name}: always on`, now); }
  else c.log.push({ t: now, id, text: `${CHEAT[id].name}: always on off` });
}
/** After a trade: arm again every Always on cheat that was used up. Returns the ids re-armed. */
export function rearm(s) {
  const c = s.cheats, out = [];
  if (!c?.always) return out;
  for (const id in c.always) if (c.always[id] && CHEAT[id]?.kind === "arm" && !c.armed[id]) { c.armed[id] = true; out.push(id); }
  return out;
}
export const isArmed = (s, id) => !!s.cheats?.armed?.[id];
export const leverage = s => s.cheats?.lev || 1;

export function setToggle(s, id, val, now) {
  if (CHEAT[id]?.kind !== "toggle") throw new E.TradeError("Unknown cheat.");
  const c = state(s);
  c.on[id] = !!val;
  if (val) mark(s, id, `${CHEAT[id].name} on`, now);
  else c.log.push({ t: now, id, text: `${CHEAT[id].name} off` });
}
export function arm(s, id, val, now) {
  if (CHEAT[id]?.kind !== "arm") throw new E.TradeError("Unknown cheat.");
  const c = state(s);
  c.armed[id] = !!val;
  if (val) mark(s, id, `${CHEAT[id].name} armed`, now);
  else c.log.push({ t: now, id, text: `${CHEAT[id].name} disarmed` });
}
export function setLeverage(s, lev, now) {
  if (!LEVERAGE.includes(lev)) throw new E.TradeError("Leverage is 10x, 50x or 100x.");
  const c = state(s);
  c.lev = lev;
  if (lev > 1) mark(s, "leverage", `Leverage ${lev}x`, now);
  else c.log.push({ t: now, id: "leverage", text: "Leverage off" });
}
/** Can this instrument be shorted right now? Leverage allows it for crypto, stocks and forex; Short anything for all. */
export function canShort(s, inst) {
  return isOn(s, "shortAll") || (leverage(s) > 1 && inst.m !== "meme");
}

export function printMoney(s, usd, now) {
  if (!PRINTER.includes(usd)) throw new E.TradeError("Pick $10K, $100K or $1M.");
  const cut = E.addCash(s, usd);
  mark(s, "printer", `Money printer: +$${(usd - cut).toLocaleString("en-US", { maximumFractionDigits: 2 })}${cut ? " (stopped at the money cap)" : ""}`, now);
  return cut;
}

export function undo(s, now) {
  const gone = E.undoLast(s);
  mark(s, "undo", gone.length ? `Undo: ${gone.map(t => `${t.side === "buy" ? (t.dir === -1 ? "short" : "buy") : (t.dir === -1 ? "cover" : "sell")} ${t.sym}`).join(", ")}` : "Undo", now);
  return gone;
}

/** The last trade, if it's a winning sale that hasn't been flipped yet. */
export function lastWin(s) {
  const t = s.trades[s.trades.length - 1];
  return t && t.side === "sell" && t.pl > 0 && !t.flip ? t : null;
}
/**
 * Double or nothing on the last winning sale. coin: a random number in [0, 1).
 * Win: the profit doubles. Lose: the whole portfolio (cash and positions) drops to $100; waiting orders are canceled.
 */
export function doubleOrNothing(s, coin, now) {
  const t = lastWin(s);
  if (!t) throw new E.TradeError("Double or nothing needs a winning sale as your last trade.");
  const won = coin < 0.5, gain = t.pl;
  let before = null;
  if (won) {
    s.cash += gain; t.usd += gain; t.pl = gain * 2;
    t.plPct = t.cost > 0 ? t.pl / t.cost : 0;
    const cut = E.capCash(s);
    if (cut) t.capped = (t.capped || 0) + cut;
  } else {
    before = E.totals(s, () => null).total;
    s.cash = DON_FLOOR; s.pos = {}; s.margin = {}; s.orders = [];
    if (s.cheats?.boost) s.cheats.boost = null;
  }
  t.flip = won ? "won" : "lost";
  (t.cheat ||= []).push(won ? "Double or nothing (won)" : "Double or nothing (lost: portfolio to $100)");
  s.undo = null; // the flip is final
  mark(s, "don", won ? `Double or nothing on ${t.sym}: doubled to $${(gain * 2).toFixed(2)}` : `Double or nothing on ${t.sym}: lost, the portfolio dropped from $${before.toFixed(2)} to $${DON_FLOOR}`, now);
  return { won, gain, before, trade: t };
}

/** Moon boost on a memecoin you hold, from its live price now. */
export function startBoost(s, key, px, now) {
  const p = s.pos[key];
  if (!p || p.inst.m !== "meme") throw new E.TradeError("Moon boost works on a memecoin you hold.");
  if (!(px > 0)) px = p.lastPx; // no live price: the last one known
  if (!(px > 0)) throw new E.TradeError("Wait for a live price.");
  const c = state(s);
  if (c.boost && now <= c.boost.until) throw new E.TradeError(`Moon boost is already running on ${s.pos[c.boost.key]?.inst.sym || "a coin"}.`);
  const base = E.gameQuote(s, key, { px }).px;
  c.boost = { key, from: now, until: now + BOOST_MS, basePx: base, lastPx: base };
  mark(s, "moon", `Moon boost on ${p.inst.sym} for 10 minutes`, now);
  return c.boost;
}
/** When the 10 minutes are over, the extra gain (at the last price seen in the window) is paid to cash. */
export function settleBoost(s, now) {
  const b = s.cheats?.boost;
  if (!b || now <= b.until) return null;
  const p = s.pos[b.key];
  const extra = p ? E.boostExtra(s, p) : 0;
  s.cheats.boost = null;
  if (extra > 0) {
    E.addCash(s, extra);
    s.cheats.log.push({ t: now, id: "moon", text: `Moon boost paid +$${extra.toFixed(2)} on ${p.inst.sym}` });
  }
  return { extra, sym: p?.inst.sym || "" };
}

export const airdropReady = (s, now) => s.cheats?.airdropDay !== localDay(now);
/** pick: a live memecoin {inst, q} chosen at random by the app from the real lists. */
export function airdrop(s, inst, q, now) {
  if (!airdropReady(s, now)) throw new E.TradeError("You already got today's airdrop. Come back tomorrow.");
  const worth = Math.round(s.start * AIRDROP_SHARE * 100) / 100;
  const t = E.executeBuy(s, inst, worth, q, now, "airdrop", false, { free: true, tags: ["Airdrop"] });
  state(s).airdropDay = localDay(now);
  mark(s, "airdrop", `Airdrop: ${inst.sym} worth $${worth.toFixed(2)}`, now);
  return t;
}

/** Copycat: your cash and positions become a copy of the bot's (your history stays; your orders are canceled). */
export function copycat(s, bot, now) {
  if (!bot) throw new E.TradeError("Add a rival bot first.");
  s.cash = bot.pf.cash;
  s.pos = structuredClone(bot.pf.pos);
  for (const k in s.pos) { s.pos[k].sl = null; s.pos[k].tp = null; delete s.pos[k].ghost; }
  s.margin = {};
  s.orders = [];
  s.undo = null;
  if (s.cheats?.boost) s.cheats.boost = null;
  E.capCash(s);
  mark(s, "copycat", `Copycat: copied ${bot.name}'s portfolio`, now);
}

