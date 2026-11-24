// Number, time and HTML helpers (English UI, US formats, prices in dollars).

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nf = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const NF2 = nf(2, 2), NF0 = nf(0, 0);
const NFDP = {};
const NF_DP = dp => (NFDP[dp] ||= new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: false }));

// Big numbers are abbreviated everywhere: $1.25K, $3.4M, $12.7B, $1.05T (3 significant figures, trailing zeros
// dropped), and never in scientific notation. tap() wraps one so that tapping it shows the full number.
const SUFFIX = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
/** 1250 → "1.25K", 3400000 → "3.4M", 999.5 → "1K". a ≥ 1000, positive. */
export function abbr(a) {
  let k = Math.min(SUFFIX.length - 1, Math.floor(Math.log10(a) / 3));
  let m = a / 10 ** (3 * k);
  let r = Number(m.toPrecision(3));
  if (r >= 1000 && k < SUFFIX.length - 1) { k++; r = Number((m / 1000).toPrecision(3)); }
  const digits = r >= 100 ? 0 : r >= 10 ? 1 : 2;
  let txt = r >= 1000 ? NF0.format(Math.round(r)) : r.toFixed(digits);
  if (txt.includes(".")) txt = txt.replace(/\.?0+$/, "");
  return txt + SUFFIX[k];
}

/** Dollars. Abbreviated from $1,000 up; {full: true} gives every digit. */
export function usd(n, { sign = false, full = false } = {}) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : sign && n > 0 ? "+" : "";
  if (!full && a >= 1000) return s + "$" + abbr(a);
  return s + "$" + NF2.format(a);
}
/** HTML for a number that may be abbreviated: tapping it shows the full one. */
export function tap(short, full) {
  return short === full ? short : `<span class="ab" data-full="${esc(full)}">${short}</span>`;
}

/** Price with sensible decimals; dp forces decimals (FX pairs). */
export function price(p, dp, { full = false } = {}) {
  if (p == null || !isFinite(p)) return "—";
  const a = Math.abs(p);
  if (dp != null) return !full && a >= 1e6 ? abbr(a) : NF_DP(dp).format(p);
  if (!full && a >= 1000) return (p < 0 ? "-$" : "$") + abbr(a);
  if (a >= 1000) return "$" + NF2.format(p);
  if (a >= 1) return "$" + p.toFixed(a >= 100 ? 2 : 4).replace(/(\.\d{2}\d*?)0+$/, "$1");
  if (p === 0) return "$0";
  const z = Math.max(0, Math.floor(-Math.log10(a)));
  return "$" + p.toFixed(Math.min(z + 4, 12));
}

/** Percent; huge ones abbreviated (+12.1K%, +1.2M%), never in scientific notation. */
export function pct(n, digits = 2, { full = false } = {}) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n > 0 ? "+" : n < 0 ? "-" : "";
  if (a >= 10000 && !full) return s + abbr(a) + "%";
  return s + (a >= 1e21 ? NF0.format(a) : a.toFixed(digits)) + "%";
}
export const dirCls = n => (n > 0 ? "up" : n < 0 ? "down" : "flat");

export function qty(n, { full = false } = {}) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return full ? NF0.format(n) : (n < 0 ? "-" : "") + abbr(a);
  if (a >= 1) return nf(0, 4).format(n);
  if (a === 0) return "0";
  const z = Math.max(0, Math.floor(-Math.log10(a)));
  return n.toFixed(Math.min(z + 4, 20)).replace(/0+$/, ""); // never 1.234e-7
}

/** 00:12:41, or "2 d 03:12:41" beyond a day. */
export function countdown(ms) {
  if (!(ms > 0)) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const hh = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
  return d ? `${d}d ${hh}` : hh;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const m = (now - ms) / 60e3;
  if (m < 1) return Math.max(0, Math.round(m * 60)) + " s";
  if (m < 60) return Math.round(m) + " min";
  if (m < 1440) return Math.round(m / 60) + " h";
  const d = Math.round(m / 1440);
  return d + (d === 1 ? " day" : " days");
}

export function dateTime(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function clock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
export function weekdayTime(ms) {
  return new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}
