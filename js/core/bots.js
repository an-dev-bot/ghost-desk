// Rival bots. Each bot has its own portfolio (same engine, same costs, same market hours as the owner)
// and decides by itself what to buy, how much and when to sell.
//
// Pure module: the app passes the live prices it really has; the tests pass hand-made ones.
// A bot only ever trades at a price that is
//   - live (produced while the app is open: t >= bootAt, and no older than MAX_AGE), and
//   - from an open market, produced after the current session started (stocks wait for the bell).
// So when the app opens after being closed, nothing is backfilled: the bot starts from the prices it sees now.

import * as E from "./engine.js";
import * as C from "./cheats.js";
import { localDay } from "./stats.js";

// Bot cheats: each bot arms one whenever it suits its next trade, with no daily limit (same engine rules as yours).
// Only Money printer is limited: once a day per bot.
// Bots never use Undo, Ghost trade, Oracle, X-ray, Time machine, Skip ahead or Always on.
export const BOT_CHEATS = [
  { id: "zeroFees", name: "Zero fees for 1 hour" },
  { id: "insurance", name: "Insurance 50%" },
  { id: "lucky", name: "2x Lucky trade" },
  { id: "rugShield", name: "Rug shield 20% for 1 hour" },
  { id: "golden", name: "Golden entry" },
  { id: "perfect", name: "Perfect exit" },
  { id: "leverage", name: "Leverage" },
  { id: "printer", name: "Money printer 10%" },
];
export const BOT_TIMED = 3600e3;
const BOT_LEV = [10, 20];

export const STYLES = {
  momentum: { name: "Momentum", desc: "Buys what is rising fastest in all 4 markets, cuts losers early." },
  contrarian: { name: "Contrarian", desc: "Buys the biggest drops in all 4 markets and sells the bounce." },
  degen: { name: "Degen", desc: "Memecoins only, big bets on new and pumping coins." },
  random: { name: "Random", desc: "Random picks, random sizes, random exits, in all 4 markets." },
};
export const STYLE_IDS = Object.keys(STYLES);
export const MAX_BOTS = 6;
export const MAX_AGE = 10 * 60e3;   // a price older than this is not "live" for a bot
export const MIN_TICKET = 10;       // smallest buy, in dollars

const MARKETS = ["meme", "crypto", "stock", "fx"];
// How much each market usually moves, relative to crypto: thresholds and exits scale with it.
const SCALE = { crypto: 1, stock: 0.5, fx: 0.1, meme: 5 };
// Per style: buy cooldown, max open positions, size as a fraction of the bot's total value.
const RULES = {
  momentum: { cooldown: 90e3, maxPos: 8, size: 0.06, tp: 0.06, sl: -0.04, enter: { crypto: 3, stock: 1.5, fx: 0.3, meme: 30 }, minLiq: 100e3 },
  contrarian: { cooldown: 120e3, maxPos: 8, size: 0.06, tp: 0.04, sl: -0.08, enter: { crypto: -4, stock: -2, fx: -0.4, meme: -30 }, minLiq: 200e3, maxHold: 48 * 3600e3 },
  degen: { cooldown: 60e3, maxPos: 4, size: 0.25, tp: 0.6, sl: -0.35, minLiq: 30e3, liqShare: 0.025, maxHold: 3 * 3600e3 },
  random: { cooldown: 45e3, maxPos: 10, buyP: 0.35, sellP: 0.06, minSize: 0.02, maxSize: 0.1 },
};

/** Small seeded PRNG (mulberry32): the Random bot is random, but a test can replay it. */
export function rng(state) {
  let a = state.seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    state.seed = a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newBot(style, { id, name, start, now, seed }) {
  if (!STYLES[style]) throw new Error("Unknown bot style: " + style);
  return { id, style, name: name || STYLES[style].name, createdAt: now, pf: E.newPortfolio(now, start), lastBuy: 0, seed: seed ?? (now % 2147483647) };
}

export function botName(style, bots) {
  const base = STYLES[style].name;
  const taken = new Set(bots.map(b => b.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * Live entries the bot may trade on right now.
 * entries: [{inst, px, t, ch24, ch1h, liq, quoteUsd}] (the app's live prices), status(m) → {open, since}.
 */
export function freshQuotes(entries, now, status, bootAt) {
  const out = new Map();
  for (const L of entries) {
    if (!L?.inst || !MARKETS.includes(L.inst.m) || !(L.px > 0) || !(L.t > 0)) continue;
    const st = status(L.inst.m);
    if (!st?.open) continue;
    if (L.t < Math.max(bootAt || 0, st.since || 0) || L.t > now + 60e3 || now - L.t > MAX_AGE) continue;
    out.set(L.inst.key, L);
  }
  return out;
}

const quoteOf = L => ({ px: L.px, t: L.t, liq: L.liq, quoteUsd: L.quoteUsd });

/** What the bot wants to do now: [{type:'sell', key, why} | {type:'buy', key, usd, why}]. */
export function decide(bot, fresh, now) {
  const R = RULES[bot.style], pf = bot.pf, rand = bot.style === "random" ? rng(bot) : null;
  const acts = [];
  const equity = E.totals(pf, k => (fresh.get(k) ? quoteOf(fresh.get(k)) : null)).total;

  // exits first
  for (const key in pf.pos) {
    const L = fresh.get(key);
    if (!L) continue; // market closed or no live price: hold
    const p = pf.pos[key], m = p.inst.m;
    const v = E.positionView(p, quoteOf(L));
    const r = v.plPct ?? 0, held = now - p.openedAt;
    let why = null;
    if (bot.style === "random") { if (rand() < R.sellP) why = "random exit"; }
    else {
      const k = bot.style === "degen" ? 1 : SCALE[m];
      if (r >= R.tp * k) why = `take profit (${(r * 100).toFixed(1)}%)`;
      else if (r <= R.sl * k) why = `stop loss (${(r * 100).toFixed(1)}%)`;
      else if (bot.style === "momentum" && L.ch24 != null && L.ch24 < 0) why = "momentum faded (24h turned negative)";
      else if (R.maxHold && held > R.maxHold) why = "held too long";
    }
    if (why) acts.push({ type: "sell", key, why });
  }

  // one buy at most per cooldown
  const open = Object.keys(pf.pos).length - acts.length;
  if (now - (bot.lastBuy || 0) < R.cooldown || open >= R.maxPos) return acts;
  const cash = E.available(pf);
  const pool = [...fresh.values()].filter(L => !pf.pos[L.inst.key]);
  let pick = null, usd = 0, why = "";

  if (bot.style === "momentum" || bot.style === "contrarian") {
    const sign = bot.style === "momentum" ? 1 : -1;
    let best = 0;
    for (const L of pool) {
      const m = L.inst.m;
      if (L.ch24 == null || !isFinite(L.ch24)) continue;
      if (m === "meme" && !(L.liq >= R.minLiq)) continue;
      if (bot.style === "momentum" && m === "meme" && L.ch1h != null && L.ch1h <= 0) continue;
      if (sign * L.ch24 < sign * R.enter[m]) continue;
      const score = sign * L.ch24 / SCALE[m];
      if (score > best) { best = score; pick = L; }
    }
    usd = equity * R.size;
    if (pick) why = `${bot.style === "momentum" ? "rising" : "dropped"} ${pick.ch24 > 0 ? "+" : ""}${pick.ch24.toFixed(2)}% in 24h`;
  } else if (bot.style === "degen") {
    let best = -Infinity;
    for (const L of pool) {
      if (L.inst.m !== "meme" || !(L.liq >= R.minLiq)) continue;
      const age = L.inst.born ? now - L.inst.born : Infinity;
      const fresh1h = age <= 60 * 60e3;
      const pump = (L.ch1h ?? -Infinity) >= 10 || (L.ch24 ?? -Infinity) >= 50;
      if (!fresh1h && !pump) continue;
      const score = (fresh1h ? 100 : 0) + (L.ch1h ?? (L.ch24 ?? 0) / 4);
      if (score > best) { best = score; pick = L; }
    }
    if (pick) {
      usd = Math.min(equity * R.size, pick.liq * R.liqShare);
      const age = pick.inst.born ? now - pick.inst.born : Infinity;
      why = age <= 60 * 60e3 ? `new coin (${Math.round(age / 60e3)} min old)` : `pumping (${pick.ch1h != null ? "1h " + pick.ch1h.toFixed(0) : "24h " + pick.ch24.toFixed(0)}%)`;
    }
  } else {
    if (pool.length && rand() < R.buyP) {
      pick = pool[Math.floor(rand() * pool.length)];
      usd = equity * (R.minSize + rand() * (R.maxSize - R.minSize));
      why = "random pick";
    }
  }
  usd = Math.floor(Math.min(usd, cash) * 100) / 100;
  if (pick && usd >= MIN_TICKET) acts.push({ type: "buy", key: pick.inst.key, usd, why });
  return acts;
}

/**
 * One bot turn: decide with fresh live prices and execute through the same engine as the owner's trades.
 * cheats: the bot may arm its own cheats for these trades. Returns the trades made (each with .why).
 */
export function step(bot, { entries, now, status, bootAt, extreme = null, cheats = false }) {
  const fresh = freshQuotes(entries, now, status, bootAt);
  for (const key in bot.pf.pos) {
    const L = fresh.get(key), p = bot.pf.pos[key];
    if (L) { p.lastPx = L.px; p.lastT = L.t; if (L.quoteUsd) p.lastQu = L.quoteUsd; }
  }
  const trades = [];
  // Leveraged positions (Leverage cheat): real liquidation with the engine's rules, then the bot's own exits.
  for (const m of E.marginPositions(bot.pf)) {
    const L = fresh.get(m.key);
    if (!L) continue;
    for (const ev of E.checkKey(bot.pf, m.key, quoteOf(L), now, status(L.inst.m))) if (ev.trade) { ev.trade.why = ev.type === "liq" ? "liquidated" : ev.type; trades.push(ev.trade); }
    if (!bot.pf.margin?.[m.id]) continue;
    const v = E.positionValue(bot.pf, m, quoteOf(L)), r = v / m.cost - 1;
    const why = r >= 0.5 ? `take profit (+${(r * 100).toFixed(0)}% on its margin)` : r <= -0.5 ? `stop loss (${(r * 100).toFixed(0)}% on its margin)` : now - m.openedAt > 3600e3 ? "held too long" : null;
    if (why && cheats) consider(bot, "lucky", r > 0, now);
    if (why) try { const t = E.closeMargin(bot.pf, m.id, 1, quoteOf(L), now, "bot"); t.why = why; trades.push(t); } catch { /* skip */ }
  }
  for (const a of decide(bot, fresh, now)) {
    const L = fresh.get(a.key), q = quoteOf(L);
    try {
      if (cheats) (a.type === "sell" ? cheatsForSell : cheatsForBuy)(bot, a, L, now, extreme);
      const opts = {}, c = bot.pf.cheats;
      let t;
      if (a.type === "sell") {
        // Perfect exit: the highest price of the day
        const hi = c?.armed?.perfect && extreme ? extreme(a.key, startOfDay(now), "high") : null;
        if (hi > 0) { opts.price = Math.max(hi, q.px); opts.tags = ["Perfect exit"]; c.armed.perfect = false; }
        t = E.executeSell(bot.pf, a.key, 1, q, now, "bot", opts);
      } else {
        // Golden entry: the lowest price of the last 15 minutes
        const lo = c?.armed?.golden && extreme ? extreme(a.key, now - 15 * 60e3, "low") : null;
        if (lo > 0) { opts.price = Math.min(lo, q.px); opts.tags = ["Golden entry"]; c.armed.golden = false; }
        if (c?.lev > 1 && L.inst.m !== "meme") { t = E.openMargin(bot.pf, L.inst, a.usd, c.lev, 1, q, now, "bot", opts); c.lev = 1; }
        else t = E.executeBuy(bot.pf, L.inst, a.usd, q, now, "bot", false, opts);
        bot.lastBuy = now;
      }
      t.why = a.why;
      trades.push(t);
    } catch { /* not enough cash or no price: skip this action */ }
  }
  if (bot.pf.trades.length > 2000) bot.pf.trades.splice(0, bot.pf.trades.length - 2000);
  return trades;
}

/**
 * X-ray: what the bot would buy (and sell) on its next turn with these live prices, without touching the bot.
 * Returns {buy: {key, sym, usd, why} | null, sells: [{key, sym, why}], wait: ms until its cooldown ends}.
 */
export function preview(bot, { entries, now, status, bootAt }) {
  const fresh = freshQuotes(entries, now, status, bootAt);
  const copy = structuredClone(bot);
  copy.lastBuy = 0;
  const acts = decide(copy, fresh, now);
  const sym = k => fresh.get(k)?.inst.sym || bot.pf.pos[k]?.inst.sym || "?";
  const b = acts.find(a => a.type === "buy");
  return {
    buy: b ? { ...b, sym: sym(b.key) } : null,
    sells: acts.filter(a => a.type === "sell").map(a => ({ ...a, sym: sym(a.key) })),
    wait: Math.max(0, RULES[bot.style].cooldown - (now - (bot.lastBuy || 0))),
  };
}

/** Leaderboard row from a portfolio: total, gain %, best and worst closed trade. */
export function standing(pf, quoteFor) {
  const t = E.totals(pf, quoteFor);
  let best = null, worst = null, n = 0, wins = 0;
  for (const x of pf.trades) {
    if (x.side !== "sell") continue;
    n++; if (x.pl > 0) wins++;
    if (!best || x.pl > best.pl) best = x;
    if (!worst || x.pl < worst.pl) worst = x;
  }
  return { total: t.total, pl: t.pl, plPct: t.plPct, best, worst, closed: n, winRate: n ? wins / n : null, open: Object.keys(pf.pos).length, trades: pf.trades.length };
}

export function validBots(list) {
  // Bots arm their own cheats; Undo and Always on are never theirs.
  if (Array.isArray(list)) for (const b of list) if (b?.pf) { delete b.pf.undo; delete b.pf.undoable; delete b.pf.cheats?.always; b.pf.margin ||= {}; }
  return Array.isArray(list) && list.every(b => b && STYLES[b.style] && typeof b.id === "string" && b.pf && typeof b.pf.cash === "number" && b.pf.start > 0 && Array.isArray(b.pf.trades) && typeof b.pf.pos === "object");
}

// ---------------------------------------------------------------- bot cheats
const startOfDay = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * When each style finds a cheat worth it. There is no daily limit: step() asks before every trade.
 * edge: how far (relative to the market's SCALE) the 15-minute low / day high must be from the price for Golden
 * entry / Perfect exit; win: profit (same scale) that deserves 2x Lucky trade; share: part of its balance that
 * makes a buy big (Insurance, Zero fees); lev: times its entry threshold that deserves Leverage (null: never).
 * Random uses a cheat it could use only half the time, on a whim.
 */
const CHEAT_WHEN = {
  momentum: { edge: 0.005, win: 0.04, share: 0.1, lev: 2 },
  contrarian: { edge: 0.01, win: 0.03, share: 0.1, lev: 2.5 },
  degen: { edge: 0.003, win: 0.02, share: 0.05, lev: null },
  random: { edge: 0, win: 0, share: 0.05, lev: 0, whim: 0.5 },
};

/** Start one cheat now, and mark it on the bot's portfolio. */
function useCheat(bot, id, now, arg) {
  const st = C.state(bot.pf);
  let text = BOT_CHEATS.find(x => x.id === id).name;
  if (id === "zeroFees" || id === "rugShield") { st.on[id] = true; (st.until ||= {})[id] = now + BOT_TIMED; }
  else if (id === "leverage") { st.lev = arg; text = `Leverage ${arg}x on its next buy`; }
  else st.armed[id] = true;
  C.mark(bot.pf, id, text, now);
}
/** The bot could use this cheat here: does it? (never when it's already running) */
function consider(bot, id, worth, now, arg) {
  if (!worth || C.isArmed(bot.pf, id) || C.isOn(bot.pf, id) || (id === "leverage" && C.leverage(bot.pf) > 1)) return;
  const whim = CHEAT_WHEN[bot.style].whim;
  if (whim && rng(bot)() >= whim) return;
  useCheat(bot, id, now, arg);
}
function cheatsForBuy(bot, a, L, now, extreme) {
  const w = CHEAT_WHEN[bot.style], m = L.inst.m, enter = RULES[bot.style].enter?.[m];
  const equity = E.totals(bot.pf, () => null).total;
  const strong = w.lev != null && m !== "meme" && (enter == null || Math.abs(L.ch24) >= w.lev * Math.abs(enter));
  consider(bot, "leverage", strong, now, m === "fx" ? BOT_LEV[1] : BOT_LEV[0]);
  const big = a.usd >= w.share * equity, levered = C.leverage(bot.pf) > 1 && m !== "meme";
  consider(bot, "insurance", m === "meme" || levered || big, now);
  consider(bot, "rugShield", m === "meme" && big, now);
  consider(bot, "zeroFees", m === "meme" || levered || big, now);
  const lo = extreme?.(a.key, now - 15 * 60e3, "low");
  consider(bot, "golden", lo > 0 && lo < L.px * (1 - w.edge * SCALE[m]), now);
}
function cheatsForSell(bot, a, L, now, extreme) {
  const w = CHEAT_WHEN[bot.style], p = bot.pf.pos[a.key], m = L.inst.m;
  const r = E.positionView(p, quoteOf(L)).plPct ?? 0;
  const hi = r > 0 ? extreme?.(a.key, startOfDay(now), "high") : null;
  consider(bot, "perfect", hi > 0 && hi > L.px * (1 + w.edge * SCALE[m]), now);
  consider(bot, "lucky", r > 0 && r >= w.win * SCALE[m], now);
  consider(bot, "rugShield", r < E.SHIELD - 1, now);
  consider(bot, "insurance", r < 0, now);
}

/**
 * Timed cheats expire, and the bot prints money (once a day) when it's losing or short of cash for its next buy.
 * The other cheats are decided in step(), trade by trade.
 * ctx: {allowed (Settings: Bots can cheat), quoteFor(key) for Money printer}. Returns [{id, text}] used now.
 */
export function cheatTick(bot, now, { allowed = true, quoteFor = () => null } = {}) {
  const c = bot.pf.cheats;
  const day = localDay(now);
  // bots saved when cheats were limited per day: today's Money printer still counts
  if (bot.cheatDay === day && bot.cheatsToday?.includes("printer")) bot.printerDay = day;
  delete bot.cheatPlan; delete bot.cheatsToday; delete bot.cheatDay;
  if (!allowed) {
    if (c) { c.on = {}; c.armed = {}; c.lev = 1; c.until = {}; }
    return [];
  }
  const until = c?.until || {};
  for (const id in until) if (now >= until[id]) { c.on[id] = false; delete until[id]; }
  if (bot.printerDay === day) return [];
  const R = RULES[bot.style], { total, pl } = E.totals(bot.pf, quoteFor);
  if (!(pl < 0 || E.available(bot.pf) < total * (R.size ?? R.maxSize))) return [];
  bot.printerDay = day;
  const add = Math.round(total * 0.1 * 100) / 100, cut = E.addCash(bot.pf, add);
  const text = `Money printer: +$${(add - cut).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (10% of its balance)`;
  C.mark(bot.pf, "printer", text, now);
  return [{ id: "printer", text }];
}

/** Recent cheats of all bots, newest first: [{bot, t, id, text}]. */
export function cheatFeed(bots, n = 4) {
  return bots.flatMap(b => (b.pf.cheats?.log || []).slice(-5).map(x => ({ bot: b, ...x }))).sort((a, b) => b.t - a.t).slice(0, n);
}
