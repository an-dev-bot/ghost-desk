// Sim mode: invented markets with invented names, prices that move on their own every second.
// Pure and seeded: the app calls step(world, now) once a second; the tests replay a world from its seed.
//
// Nothing here is real and the app says so everywhere ("Sim"). The world only moves while the app is open:
// when it comes back, it continues from where it was (no fast-forward through the time it was closed).
//
// Bars are compact arrays [t, o, h, l, c, gold]; gold = 1 marks a candle inside a pump.
//
// Random streams: every instrument and currency has its own (i.rs), events have theirs (w.evr) and new coins use
// the world's (w.rs). A coin's future depends only on its own stream and on the events, so the Oracle can play it
// ahead on a copy of the world and it happens exactly like that.

export const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const B1_MAX = 360, BH_MAX = 240, BD_MAX = 120;   // 6 hours of 1m, 10 days of 1h, 120 days of 1d
export const MAX_MEMES = 45;
export const MAX_GAP = 30e3;                        // a longer gap (app closed or hidden) is not simulated
export const VERSION = 2;
export const SKIPS = { "1m": 60e3, "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": 3600e3, "1d": 86400e3, "1w": 7 * 86400e3 };

// Volatility per second, by market: crypto high, stocks with crashes and rallies, forex calm except news.
export const SIG = { crypto: 0.0003, stock: 0.00012, fx: 0.00002, meme: 0.004 };
// Crypto, stocks and currencies drift back toward their usual price (a gap halves in about 12 hours), so crashes, rallies and events stay big but a long Skip ahead never ends at zero or at infinity.
export const REVERT = Math.LN2 / (12 * 3600);

export const EVENTS = {
  bull: { icon: "🐂", title: "Bull run", text: "Everything is going up", dur: 75 },
  blackSwan: { icon: "🦢", title: "Black swan", text: "Everything is crashing", dur: 45 },
  whaleAlert: { icon: "🐋", title: "Whale alert", dur: 40 },
  shortSqueeze: { icon: "🩳", title: "Short squeeze", dur: 60 },
  fedSurprise: { icon: "🏦", title: "Fed surprise", text: "A rate surprise: forex jumps, stocks swing", dur: 45 },
  elonTweet: { icon: "🚀", title: "Elon tweet", dur: 60 },
};
export const EVENT_IDS = Object.keys(EVENTS);

const CRYPTO = [
  ["Nebulon", "NBL", 41800], ["Quarkcoin", "QRK", 2650], ["Solace", "SLC", 148], ["Vortexa", "VTX", 0.62], ["Helion", "HEL", 7.4],
  ["Orbitum", "ORB", 23.1], ["Zephyr Chain", "ZPH", 0.094], ["Lumen X", "LMX", 1.18], ["Kairos", "KRS", 312], ["Driftcoin", "DRF", 0.0071],
  ["Aetherium Nova", "ATN", 56.2], ["Pulsar", "PLS", 4.05], ["Cobalt Net", "CBN", 0.38], ["Ion Swap", "ION", 11.9],
];
const STOCKS = [
  ["Zentrix Robotics", "ZTRX", 184], ["Halcyon Foods", "HLCN", 42.3], ["Nova Motors", "NVMT", 263], ["Bluepeak Energy", "BLPK", 77.8],
  ["Cindervale Pharma", "CNDV", 129], ["Orion Grid", "ORGD", 35.6], ["Quill & Co", "QUIL", 18.2], ["Tidewater Bank", "TDWB", 61.4],
  ["Paragon Air", "PRGA", 23.9], ["Ember Semiconductor", "EMBR", 512], ["Lattice Cloud", "LTCD", 96.5], ["Sunforge Solar", "SNFG", 14.7],
  ["Redwood Retail", "RDWR", 54.1], ["Mirage Games", "MRGG", 33.3],
];
const CURRENCIES = { ZVK: ["Zorvian Krona", 0.091], LUD: ["Lunar Dollar", 1.27], NMF: ["Nimbus Franc", 0.0062], AUP: ["Aurum Peso", 0.054], KSY: ["Kestrel Yen", 0.0071] };
const FX = [["ZVK", "USD"], ["LUD", "USD"], ["USD", "NMF"], ["USD", "KSY"], ["AUP", "USD"], ["LUD", "ZVK"], ["LUD", "KSY"], ["ZVK", "AUP"]];
const MEME_A = ["Moon", "Frog", "Cat", "Turbo", "Giga", "Based", "Rocket", "Ghost", "Banana", "Laser", "Chad", "Sigma", "Pixel", "Goblin", "Hamster", "Penguin", "Toad", "Noodle", "Wizard", "Pickle", "Llama", "Spork", "Yeti", "Blob", "Zorp", "Gloop", "Snek", "Bork", "Mochi", "Taco", "Waffle", "Crab", "Otter", "Disco", "Sushi"];
const MEME_B = ["Inu", "Hat", "Coin", "Mania", "Lord", "King", "Rizz", "Bros", "2.0", "Pump", "Mooner", "Gang", "Cult", "AI", "Fi", "Verse", "Mob", "Club", "Jr", "Max"];

// ---------------------------------------------------------------- random (state kept in the world, so a saved world continues the same way)
export function rand(w) {
  const a = (w.rs = (w.rs + 0x6d2b79f5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const U = (w, a, b) => a + (b - a) * rand(w);
const seedOf = w => (rand(w) * 4294967296) >>> 0;
/** Seconds of [a, b] inside (t0, t1]. */
const ov = (a, b, t0, t1) => Math.max(0, Math.min(b, t1) - Math.max(a, t0)) / 1000;
const pick = (w, arr) => arr[Math.floor(rand(w) * arr.length)];
function gauss(w) {
  let u = 0;
  while (!u) u = rand(w);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand(w));
}

// ---------------------------------------------------------------- bars
function put(arr, ms, t, px, gold, max) {
  const st = Math.floor(t / ms) * ms;
  const last = arr[arr.length - 1];
  if (last && last[0] === st) {
    if (px > last[2]) last[2] = px;
    if (px < last[3]) last[3] = px;
    last[4] = px;
    if (gold) last[5] = 1;
  } else if (!last || st > last[0]) {
    const o = last ? last[4] : px;
    arr.push([st, o, Math.max(o, px), Math.min(o, px), px, gold ? 1 : 0]);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }
}
function addPrice(i, t, px, gold = false) {
  put(i.b1, MIN, t, px, gold, B1_MAX);
  put(i.bh, HOUR, t, px, gold, BH_MAX);
  put(i.bd, DAY, t, px, false, BD_MAX);
  i.px = px; i.t = t;
}

/** Price at time t: close of the last bar starting at or before t (finest series that covers it). */
export function priceAt(i, t) {
  if (i.born && t <= i.born) return i.px0;
  for (const arr of [i.b1, i.bh, i.bd]) {
    if (!arr.length || arr[0][0] > t) continue;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid][0] <= t) lo = mid; else hi = mid - 1; }
    return arr[lo][4];
  }
  return i.px0 ?? null;
}

const toObj = b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], g: b[5] || 0 });
/** Candles for the chart: 1m, 5m (from 1m), 1h, 1d. */
export function bars(i, ivl) {
  if (ivl === "1m") return i.b1.map(toObj);
  if (ivl === "1h") return i.bh.map(toObj);
  if (ivl === "1d") return i.bd.map(toObj);
  const out = [];
  for (const b of i.b1) {
    const st = Math.floor(b[0] / 300e3) * 300e3, last = out[out.length - 1];
    if (last && last.t === st) { last.h = Math.max(last.h, b[2]); last.l = Math.min(last.l, b[3]); last.c = b[4]; last.g ||= b[5]; }
    else out.push({ t: st, o: b[1], h: b[2], l: b[3], c: b[4], g: b[5] || 0 });
  }
  return out;
}

// ---------------------------------------------------------------- world
function base(m, id, sym, name, px, t, extra = {}) {
  return { key: `${m}:${id}`, m, id, sym, name, px, px0: px, t, b1: [], bh: [], bd: [], ...extra };
}

/** History from `from` to `to` with a random walk (steps of `stepMs`), so every coin has candles since it exists. */
function history(w, i, from, to, stepMs) {
  const dt = stepMs / 1000;
  for (let t = from; t < to; t += stepMs) {
    for (let k = 0; k < 3; k++) moveInst(w, i, t + (k * stepMs) / 3, dt / 3, null, true);
  }
}
function layeredHistory(w, i, from, to) {
  const h1 = Math.max(from, to - 10 * DAY), m1 = Math.max(from, to - 6 * HOUR);
  if (from < h1) history(w, i, from, h1, 6 * HOUR);
  if (h1 < m1) history(w, i, h1, m1, 15 * MIN);
  history(w, i, m1, to, MIN);
}

export function createWorld(seed, now) {
  const w = {
    v: VERSION, rs: seed >>> 0, seed: seed >>> 0, t: now, created: now, insts: {}, cur: {}, memes: [],
    event: null, nextEventAt: now + 45e3, nextCoinAt: now + 3e3, coinN: 0, off: 0,
  };
  w.evr = { rs: seedOf(w) };
  const from = now - BD_MAX * DAY;
  for (const [name, sym, px] of CRYPTO) {
    const i = w.insts[`crypto:${sym}`] = base("crypto", sym, sym, name, px, from, { crowd: U(w, 0.2, 0.9), supply: Math.round(U(w, 2e7, 5e9)), rs: seedOf(w) });
    layeredHistory(w, i, from, now);
  }
  for (const [name, sym, px] of STOCKS) {
    const i = w.insts[`stock:${sym}`] = base("stock", sym, sym, name, px, from, { crowd: U(w, 0.1, 0.8), rs: seedOf(w) });
    layeredHistory(w, i, from, now);
  }
  for (const c in CURRENCIES) w.cur[c] = { name: CURRENCIES[c][0], usd: CURRENCIES[c][1], usd0: CURRENCIES[c][1], rs: seedOf(w) };
  w.cur.USD = { name: "US Dollar", usd: 1 };
  for (const [b, q] of FX) {
    const px = w.cur[b].usd / w.cur[q].usd;
    w.insts[`fx:${b}${q}`] = base("fx", b + q, `${b}/${q}`, `${w.cur[b].name} / ${w.cur[q].name}`, px, from, { base: b, quote: q, dp: px >= 20 ? 3 : px >= 2 ? 4 : 5 });
  }
  fxHistory(w, from, now);
  // memecoins already alive when the world starts: born between 2 minutes and 20 hours ago
  for (let k = 0; k < 22; k++) {
    const born = now - Math.round(Math.exp(U(w, Math.log(2 * MIN), Math.log(20 * HOUR))));
    newCoin(w, born, now);
  }
  w.memes.sort((a, b) => w.insts[a].born - w.insts[b].born);
  return w;
}

function fxHistory(w, from, to) {
  const h1 = Math.max(from, to - 10 * DAY), m1 = Math.max(from, to - 6 * HOUR);
  const run = (a, b, stepMs) => {
    for (let t = a; t < b; t += stepMs) {
      for (const c in w.cur) if (c !== "USD") { const cur = w.cur[c]; cur.usd *= Math.exp(-REVERT * Math.log(cur.usd / cur.usd0) * (stepMs / 1000) + SIG.fx * Math.sqrt(stepMs / 1000) * gauss(cur)); }
      for (const i of Object.values(w.insts)) if (i.m === "fx") addPrice(i, t, w.cur[i.base].usd / w.cur[i.quote].usd);
    }
  };
  run(from, h1, 6 * HOUR); run(h1, m1, 15 * MIN); run(m1, to, MIN);
}

function memeName(w) {
  for (let tries = 0; tries < 20; tries++) {
    const a = pick(w, MEME_A), b = pick(w, MEME_B);
    const name = `${a} ${b}`;
    let sym = (a.slice(0, 3) + b.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)).toUpperCase();
    if (rand(w) < 0.3) sym = (a + b).replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 6);
    if (!Object.values(w.insts).some(i => i.sym === sym)) return [name, sym];
  }
  return [`Coin ${w.coinN}`, `C${w.coinN}`];
}

/** A new memecoin with its fate decided at birth: most bleed, some pump +1,000%, very few moonshot 100x, many rug. */
function newCoin(w, born, now) {
  const [name, sym] = memeName(w);
  const id = "sim" + (++w.coinN).toString(36) + sym;
  const px = Math.pow(10, U(w, -5, -3)); // market cap $10K to $1M at birth
  const r = rand(w);
  const kind = r < 0.015 ? "moonshot" : r < 0.23 ? "pump" : "normal";
  const pumpAt = born + U(w, 20e3, 8 * MIN), pumpDur = kind === "moonshot" ? U(w, 300, 720) : U(w, 120, 360);
  const mult = kind === "moonshot" ? U(w, 80, 150) : kind === "pump" ? U(w, 8, 15) : 0;
  const rugs = rand(w) < (kind === "normal" ? 0.4 : 0.5);
  const rugAt = !rugs ? null : kind === "normal" ? born + U(w, 60e3, 25 * MIN) : pumpAt + pumpDur * 1000 + U(w, 30e3, 5 * MIN);
  const i = base("meme", id, sym, name, px, born, {
    born, supply: 1e9, liq0: U(w, 6e3, 60e3), dead: false, fate: { kind, pumpAt, pumpDur, mult, rugAt }, rs: seedOf(w),
  });
  i.liq = i.liq0;
  w.insts[i.key] = i;
  w.memes.push(i.key);
  if (now > born) {
    const step = now - born > 6 * HOUR ? 10 * MIN : MIN;
    const m1 = Math.max(born, now - 6 * HOUR);
    if (born < m1) history(w, i, born, m1, step);
    history(w, i, m1, now, MIN);
  } else addPrice(i, born, px);
  return i;
}

// ---------------------------------------------------------------- one step (1 second live, longer when skipping ahead)
/** Drift per second an event gives this instrument. */
function eventMu(ev, i) {
  switch (ev.type) {
    case "bull": return { crypto: 0.00096, stock: 0.00054, meme: 0.0036, fx: 0 }[i.m]; // as much up as a Black swan takes down
    case "blackSwan": return { crypto: -0.0016, stock: -0.0009, meme: -0.006, fx: 0 }[i.m];
    case "whaleAlert": return ev.keys.includes(i.key) ? ev.dir * 0.0006 : 0;
    case "shortSqueeze": return ev.keys.includes(i.key) ? 0.0025 : 0;
    case "fedSurprise": return i.m === "stock" ? ev.dir * 0.0006 : 0;
    case "elonTweet": return ev.keys.includes(i.key) ? ev.rate : 0;
  }
  return 0;
}

/**
 * Move one instrument from t - dt seconds to t. out (or null) collects what happened. quiet = building history.
 * Pumps, events, crashes, rallies and cascades count only for the part of their window inside the step.
 */
function moveInst(w, i, t, dt, out, quiet = false, opts = {}) {
  if (i.m === "fx") return;
  const t0 = t - dt * 1000;
  let drift = 0, sig = SIG[i.m], gold = false, jump = 1;
  if (i.m === "meme") {
    const f = i.fate;
    drift = -0.00005 * dt;
    const o = !i.dead && f.mult ? ov(f.pumpAt, f.pumpAt + f.pumpDur * 1000, t0, t) : 0;
    if (o > 0) {
      drift += (Math.log(f.mult) / f.pumpDur) * o; gold = true;
      if (!i.pumping) { i.pumping = true; if (!quiet) out?.push({ kind: f.kind === "moonshot" ? "moonshot" : "pump", key: i.key }); }
    } else i.pumping = false;
    if (!i.dead && f.rugAt && t >= f.rugAt) {
      i.dead = true; jump = U(i, 0.005, 0.04); i.liq *= 0.02;
      if (!quiet) out?.push({ kind: "rug", key: i.key, drop: 1 - jump });
    }
    if (i.dead) { sig *= 0.3; drift = -0.0004 * dt; }
    else if (!quiet && rand(i) < Math.min(0.5, dt / 600)) {
      const up = rand(i) < 0.55;
      jump = up ? U(i, 1.2, 1.7) : U(i, 0.55, 0.8);
      out?.push({ kind: "whale", key: i.key, up, move: jump - 1 });
    }
  } else {
    drift -= Math.min(0.5, REVERT * dt) * Math.log(i.px / i.px0);
    if (i.m === "stock") {
      if (i.reg && t0 >= i.reg.until) i.reg = null;
      if (!i.reg && !quiet && rand(i) < Math.min(0.5, dt / 1500)) {
        const crash = rand(i) < 0.5;
        i.reg = { type: crash ? "crash" : "rally", mu: (crash ? -1 : 1) * U(i, 0.001, 0.0025), from: t, until: t + U(i, 30, 120) * 1000 };
        out?.push({ kind: i.reg.type, key: i.key });
      }
      if (i.reg) drift += i.reg.mu * ov(i.reg.from ?? t0, i.reg.until, t0, t);
    }
    if (i.casc && t0 >= i.casc.until) i.casc = null;
    if (i.casc) drift += i.casc.mu * ov(i.casc.from ?? t0, i.casc.until, t0, t);
  }
  const ev = w.event;
  if (ev) drift += eventMu(ev, i) * ov(ev.start, ev.until, t0, t);
  let px = i.px * jump * Math.exp(drift + sig * Math.sqrt(dt) * gauss(i));
  px = Math.max(px, i.m === "meme" ? 1e-12 : 1e-6);
  if (i.m === "meme" && !i.dead) i.liq = Math.min(5e7, i.liq0 * Math.sqrt(px / i.px0), px * i.supply * 0.8);
  addPrice(i, t, px, gold);
  // liquidation cascade: a sharp drop with a crowded long side (yours included) liquidates more longs, which drops it more
  if (!quiet && (i.m === "crypto" || i.m === "stock") && !i.casc && t - (i.cascAt || 0) > 5 * MIN) {
    const prev = priceAt(i, t - MIN);
    const crowd = (i.crowd || 0) + Math.min(0.4, (opts.lev?.[i.key] || 0) / 2e5);
    const th = i.m === "crypto" ? -0.025 : -0.018;
    if (prev && px / prev - 1 <= th && crowd >= 0.45) {
      i.casc = { mu: -0.002 * crowd, from: t, until: t + 20e3 }; i.cascAt = t;
      out?.push({ kind: "cascade", key: i.key, usd: Math.round(crowd * U(i, 30, 250)) * 1e6 });
    }
  }
}

function startEvent(w, t, forced) {
  const r = w.evr;
  const type = EVENTS[forced] ? forced : pick(r, EVENT_IDS), spec = EVENTS[type];
  const ev = { type, icon: spec.icon, title: spec.title, text: spec.text || "", start: t, until: t + spec.dur * 1000, keys: [], dir: 1 };
  const list = m => Object.values(w.insts).filter(i => i.m === m && !i.dead);
  if (type === "whaleAlert") {
    const i = pick(r, list("crypto"));
    ev.dir = rand(r) < 0.5 ? 1 : -1; ev.keys = [i.key];
    const move = U(r, 0.05, 0.12);
    addPrice(i, t, i.px * (1 + ev.dir * move));
    ev.text = `${Math.round(U(r, 5e3, 9e4)).toLocaleString("en-US")} ${i.sym} just moved: ${i.sym} ${ev.dir > 0 ? "jumps" : "drops"} ${Math.round(move * 100)}%`;
  } else if (type === "shortSqueeze") {
    const all = list("stock");
    for (let k = 0; k < 3; k++) { const i = pick(r, all); if (!ev.keys.includes(i.key)) ev.keys.push(i.key); }
    ev.text = `${ev.keys.map(k => w.insts[k].sym).join(", ")} shorts are getting squeezed`;
  } else if (type === "fedSurprise") {
    ev.dir = rand(r) < 0.5 ? 1 : -1;
    for (const c in w.cur) if (c !== "USD") w.cur[c].usd *= 1 + (rand(r) < 0.5 ? -1 : 1) * U(r, 0.003, 0.012);
  } else if (type === "elonTweet") {
    const young = list("meme").filter(i => t - i.born < 6 * HOUR);
    const i = pick(r, young.length ? young : list("meme"));
    ev.keys = [i.key]; ev.rate = Math.log(U(r, 5, 20)) / spec.dur;
    ev.text = `A famous tweet just mentioned ${i.sym}`;
  }
  return ev;
}

/** Drop old memecoins nobody holds (keep: keys the app still needs). */
function prune(w, keep, t) {
  const alive = w.memes.filter(k => w.insts[k]);
  const drop = new Set();
  for (const k of alive) { const i = w.insts[k]; if (i.dead && t - i.fate.rugAt > 15 * MIN && !keep.has(k)) drop.add(k); }
  const rest = alive.filter(k => !drop.has(k));
  for (let n = 0; rest.length - n > MAX_MEMES && n < rest.length; n++) if (!keep.has(rest[n])) drop.add(rest[n]);
  for (const k of drop) delete w.insts[k];
  w.memes = alive.filter(k => !drop.has(k));
  return [...drop];
}

function tick(w, t, out, opts, dt = 1) {
  // forex: calm currencies, news jumps now and then
  for (const c in w.cur) {
    if (c === "USD") continue;
    const cur = w.cur[c];
    let r = -REVERT * Math.log(cur.usd / cur.usd0) * dt + SIG.fx * Math.sqrt(dt) * gauss(cur);
    if (rand(cur) < Math.min(0.5, dt / 2400)) { const j = (rand(cur) < 0.5 ? -1 : 1) * U(cur, 0.004, 0.012); r += j; out.push({ kind: "news", cur: c, move: j }); }
    cur.usd *= Math.exp(r);
  }
  for (const i of Object.values(w.insts)) {
    if (i.m === "fx") addPrice(i, t, w.cur[i.base].usd / w.cur[i.quote].usd);
    else moveInst(w, i, t, dt, out, false, opts);
  }
  if (w.event && t > w.event.until) { out.push({ kind: "end", ev: w.event }); w.event = null; }
  if (!w.event && t >= w.nextEventAt) {
    w.event = startEvent(w, t);
    out.push({ kind: "event", ev: w.event });
    w.nextEventAt = w.event.until + U(w.evr, 120, 360) * 1000;
  }
  if (t >= w.nextCoinAt) {
    const i = newCoin(w, t, t);
    out.push({ kind: "coin", key: i.key });
    w.nextCoinAt = t + U(w, 4, 10) * 1000;
    const gone = prune(w, opts.keep || new Set(), t);
    if (gone.length) out.push({ kind: "gone", keys: gone });
  }
}

/**
 * Advance the world to `now`, one simulated second at a time. opts = {keep: Set of keys to keep, lev: {key: leveraged USD}}.
 * Returns what happened: events starting/ending, new coins, pumps, moonshots, rugs, whales, crashes, rallies, news, cascades.
 */
export function step(w, now, opts = {}) {
  const out = [];
  if (now - w.t > MAX_GAP) w.t = now - MAX_GAP;
  while (w.t + 1000 <= now) { w.t += 1000; tick(w, w.t, out, opts); }
  return out;
}

/** One step of dt seconds (Skip ahead). */
export function stepBy(w, dt, opts = {}) {
  const out = [];
  w.t += dt * 1000;
  tick(w, w.t, out, opts, dt);
  return out;
}

/**
 * How Skip ahead plays `ms`: the last 6 hours in 20-second steps (so the 1-minute candles are complete),
 * anything before that in 5-minute steps. Returns [{dt (seconds), n (steps)}] in order.
 */
export function skipPlan(ms) {
  const fine = Math.min(ms, 6 * HOUR), coarse = ms - fine, plan = [];
  if (coarse > 0) plan.push({ dt: 300, n: Math.round(coarse / 300e3) });
  plan.push({ dt: 20, n: Math.round(fine / 20e3) });
  return plan;
}

/**
 * Oracle: play `secs` seconds ahead on a copy of the world (same opts as the live one) and return the path of one
 * instrument, second by second, and its copy (with the future candles). The real world is not touched.
 */
export function future(w, key, secs, opts = {}) {
  const c = structuredClone(w);
  const path = [];
  for (let n = 0; n < secs; n++) {
    c.t += 1000;
    tick(c, c.t, [], opts, 1);
    const i = c.insts[key];
    if (!i) break;
    path.push([c.t, i.px]);
  }
  return { path, inst: c.insts[key] || null };
}

/** The same for every instrument alive now, in one run: {t0, paths: {key: Float64Array of prices, one per second}, insts}. */
export function futureAll(w, secs, opts = {}) {
  const c = structuredClone(w), paths = {}, t0 = w.t;
  for (const k in c.insts) paths[k] = new Float64Array(secs);
  for (let n = 0; n < secs; n++) {
    c.t += 1000;
    tick(c, c.t, [], opts, 1);
    for (const k in paths) if (c.insts[k]) paths[k][n] = c.insts[k].px; // 0: the coin is gone by then
  }
  return { t0, paths, insts: c.insts };
}

/** The best single trade on a path: buy at the lowest point before the biggest gain, sell at that peak. null if no gain. */
export function bestTrade(path, now, px) {
  let lo = { t: now, px }, best = null;
  for (const [t, p] of path) {
    if (lo.px > 0 && (!best || p / lo.px - 1 > best.gain)) best = { buy: { ...lo }, sell: { t, px: p }, gain: p / lo.px - 1 };
    if (p < lo.px) lo = { t, px: p };
  }
  return best && best.gain > 0 ? best : null;
}

/** Start a global event now (tests). */
export function forceEvent(w, type, t = w.t) {
  const ev = startEvent(w, t, type);
  w.event = ev;
  w.nextEventAt = ev.until + 120e3;
  return ev;
}

// ---------------------------------------------------------------- what the app shows
const ch = (now, then) => (then > 0 ? (now / then - 1) * 100 : null);
/** The live entry the app uses for an instrument (same fields as the real sources). */
export function quote(w, i) {
  const t = i.t, px = i.px;
  const d = { px, t, ch24: ch(px, priceAt(i, t - DAY)) };
  if (i.m === "meme") {
    Object.assign(d, { ch5m: ch(px, priceAt(i, t - 5 * MIN)), ch1h: ch(px, priceAt(i, t - HOUR)), ch6h: ch(px, priceAt(i, t - 6 * HOUR)), liq: i.liq, mc: px * i.supply, vol: i.liq * (i.dead ? 0.3 : 3.5) });
  } else if (i.m === "crypto") {
    d.ch1h = ch(px, priceAt(i, t - HOUR)); d.vol = px * i.supply * 0.04;
  } else if (i.m === "stock") {
    const day = i.bd[i.bd.length - 1], prev = i.bd[i.bd.length - 2];
    Object.assign(d, { o: day?.[1], hi: day?.[2], lo: day?.[3], prev: prev?.[4] });
  } else {
    d.quoteUsd = w.cur[i.quote].usd;
  }
  return d;
}
/** The instrument as the app stores it (no candles). */
export function instOf(i) {
  const o = { key: i.key, m: i.m, id: i.id, sym: i.sym, name: i.name, sim: 1 };
  if (i.born) o.born = i.born;
  if (i.m === "fx") { o.base = i.base; o.quote = i.quote; o.dp = i.dp; }
  return o;
}

export function lists(w) {
  const all = Object.values(w.insts);
  const memes = all.filter(i => i.m === "meme");
  const q = i => quote(w, i);
  return {
    crypto: all.filter(i => i.m === "crypto").sort((a, b) => b.px * (b.supply || 0) - a.px * (a.supply || 0)).map(i => i.key),
    stock: all.filter(i => i.m === "stock").map(i => i.key),
    fx: all.filter(i => i.m === "fx").map(i => i.key),
    trending: memes.filter(i => !i.dead).sort((a, b) => (q(b).ch1h ?? 0) - (q(a).ch1h ?? 0)).slice(0, 30).map(i => i.key),
    fresh: memes.slice().sort((a, b) => b.born - a.born).slice(0, 30).map(i => i.key),
  };
}

/** Search by name or symbol. */
export function search(w, m, text) {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  return Object.values(w.insts).filter(i => i.m === m && (i.sym.toLowerCase().includes(s) || i.name.toLowerCase().includes(s))).map(i => i.key).slice(0, 30);
}

/**
 * One-minute candles between from and to for the Time machine: the last 6 hours are the real Sim minutes;
 * older hours are filled with a seeded path between that hour's open and close, inside its high and low.
 */
export function minuteHistory(i, from, to) {
  const out = new Map();
  const first1m = i.b1.length ? i.b1[0][0] : Infinity;
  for (const h of i.bh) {
    if (h[0] + HOUR <= from || h[0] >= to || h[0] >= first1m) continue;
    let s = (h[0] / 1000) ^ i.id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
    const r = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const walk = [0];
    for (let k = 1; k <= 60; k++) walk.push(walk[k - 1] + (r() - 0.5));
    const lo = Math.log(h[3]), hi = Math.log(h[2]), a = Math.log(h[1]), b = Math.log(h[4]);
    const amp = (hi - lo) / 3 || 1e-6;
    let prev = h[1];
    for (let k = 1; k <= 60; k++) {
      const x = a + (b - a) * (k / 60) + (walk[k] - (k / 60) * walk[60]) * amp;
      const c = k === 60 ? h[4] : Math.exp(Math.min(hi, Math.max(lo, x)));
      const t = h[0] + (k - 1) * MIN;
      if (t >= from && t < to) out.set(t, { t, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c });
      prev = c;
    }
  }
  for (const b of i.b1) if (b[0] >= from && b[0] < to) out.set(b[0], toObj(b));
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Leveraged exposure per key, for cascades ("if many are leveraged"). */
export function leverageByKey(portfolios) {
  const m = {};
  for (const pf of portfolios) for (const p of Object.values(pf?.margin || {})) if (p.dir > 0) m[p.key] = (m[p.key] || 0) + p.cost * p.lev;
  return m;
}
