// Real trading hours, computed in New York time.
//   Stocks (NYSE/Nasdaq regular session): 9:30–16:00 Mon–Fri, minus exchange holidays, 13:00 on early-close days.
//   FX: Sunday 17:00 → Friday 17:00.
//   Crypto and memecoins: always open.
// Holidays come from the NYSE published calendar; Finnhub's market-holiday list (when there is a key) adds to it.

const TZ = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function nyParts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD.indexOf(o.weekday) };
}

/** UTC epoch ms for a New York wall-clock time. */
export function nyToUtc(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - want;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}

const pad = n => String(n).padStart(2, "0");
export const ymd = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;

// NYSE full-day closures (published by NYSE).
const HOLIDAYS = {
  "2025-01-01": "New Year's Day", "2025-01-09": "National Day of Mourning", "2025-01-20": "Martin Luther King Jr. Day",
  "2025-02-17": "Presidents' Day", "2025-04-18": "Good Friday", "2025-05-26": "Memorial Day",
  "2025-06-19": "Juneteenth", "2025-07-04": "Independence Day", "2025-09-01": "Labor Day",
  "2025-11-27": "Thanksgiving", "2025-12-25": "Christmas",
  "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-16": "Presidents' Day",
  "2026-04-03": "Good Friday", "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day", "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving",
  "2026-12-25": "Christmas",
  "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day", "2027-02-15": "Presidents' Day",
  "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth",
  "2027-07-05": "Independence Day", "2027-09-06": "Labor Day", "2027-11-25": "Thanksgiving",
  "2027-12-24": "Christmas",
};
// Early closes (13:00 New York).
const EARLY = { "2025-07-03": 13, "2025-11-28": 13, "2025-12-24": 13, "2026-11-27": 13, "2026-12-24": 13, "2027-11-26": 13 };

/** Merge Finnhub /stock/market-holiday rows: [{eventName, atDate, tradingHour}] ("" = closed all day). */
export function addHolidays(rows) {
  for (const r of rows || []) {
    if (!r?.atDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.atDate)) continue;
    if (!r.tradingHour) { HOLIDAYS[r.atDate] ??= r.eventName || "Holiday"; continue; }
    const m = /-(\d{1,2}):(\d{2})$/.exec(r.tradingHour); // e.g. "09:30-13:00"
    if (m && +m[1] < 16) EARLY[r.atDate] = +m[1] + +m[2] / 60;
  }
}

export function holidayName(key) { return HOLIDAYS[key] || null; }

function civil(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

/** Regular session of a NY calendar date, or null (weekend / holiday). */
export function stockSessionFor(y, mo, d) {
  const c = civil(y, mo, d);
  if (c.wd === 0 || c.wd === 6) return null;
  const key = ymd(c.y, c.mo, c.d);
  if (HOLIDAYS[key]) return null;
  const closeH = EARLY[key] ?? 16;
  const ch = Math.floor(closeH), cm = Math.round((closeH - ch) * 60);
  return { day: key, open: nyToUtc(c.y, c.mo, c.d, 9, 30), close: nyToUtc(c.y, c.mo, c.d, ch, cm), early: closeH !== 16 };
}

/**
 * {open, since, closesAt, early} while open;
 * {open:false, nextOpen, reason:'pre'|'post'|'weekend'|'holiday', holiday?} while closed.
 */
export function stockStatus(now) {
  const p = nyParts(now);
  const today = stockSessionFor(p.y, p.mo, p.d);
  if (today && now >= today.open && now < today.close) {
    return { open: true, since: today.open, closesAt: today.close, early: today.early };
  }
  const todayKey = ymd(p.y, p.mo, p.d);
  let reason = "weekend";
  if (today) reason = now < today.open ? "pre" : "post";
  else if (HOLIDAYS[todayKey]) reason = "holiday";
  for (let k = 0; k < 20; k++) {
    const c = civil(p.y, p.mo, p.d + k);
    const s = stockSessionFor(c.y, c.mo, c.d);
    if (s && s.open > now) return { open: false, nextOpen: s.open, nextClose: s.close, reason, holiday: HOLIDAYS[todayKey] || null };
  }
  return { open: false, nextOpen: null, reason };
}

/** End of the most recent regular session at or before `now` (for cache freshness). */
export function lastStockActivity(now) {
  const st = stockStatus(now);
  if (st.open) return now;
  const p = nyParts(now);
  for (let k = 0; k < 20; k++) {
    const c = civil(p.y, p.mo, p.d - k);
    const s = stockSessionFor(c.y, c.mo, c.d);
    if (s && s.close <= now) return s.close;
  }
  return now;
}

export function fxStatus(now) {
  const p = nyParts(now);
  const minute = p.wd * 1440 + p.h * 60 + p.mi;
  const OPEN = 17 * 60, CLOSE = 5 * 1440 + 17 * 60; // Sun 17:00, Fri 17:00
  const sun = civil(p.y, p.mo, p.d - p.wd);
  const fri = civil(sun.y, sun.mo, sun.d + 5);
  if (minute >= OPEN && minute < CLOSE) {
    return { open: true, since: nyToUtc(sun.y, sun.mo, sun.d, 17, 0), closesAt: nyToUtc(fri.y, fri.mo, fri.d, 17, 0) };
  }
  const days = (7 - p.wd) % 7; // Sunday → 0, Friday → 2, Saturday → 1
  const nxt = civil(p.y, p.mo, p.d + days);
  return { open: false, nextOpen: nyToUtc(nxt.y, nxt.mo, nxt.d, 17, 0), reason: "weekend" };
}

export function lastFxActivity(now) {
  const st = fxStatus(now);
  if (st.open) return now;
  const p = nyParts(now);
  const back = p.wd === 5 ? 0 : p.wd === 6 ? 1 : 2; // Friday this week
  const fri = civil(p.y, p.mo, p.d - back);
  return nyToUtc(fri.y, fri.mo, fri.d, 17, 0);
}

/** Uniform view for the order engine: {open, since}. */
export function marketStatus(m, now) {
  if (m === "stock") return stockStatus(now);
  if (m === "fx") return fxStatus(now);
  return { open: true, since: 0 };
}

export function lastActivity(m, now) {
  if (m === "stock") return lastStockActivity(now);
  if (m === "fx") return lastFxActivity(now);
  return now;
}
