// Number, time and HTML helpers (English UI, US formats, prices in dollars).

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nf = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const NF2 = nf(2, 2), NF0 = nf(0, 0);

export function usd(n, { sign = false, compact = false } = {}) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : sign && n > 0 ? "+" : "";
  if (compact) {
    if (a >= 1e12) return s + "$" + (a / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return s + "$" + (a / 1e3).toFixed(1) + "K";
  }
  return s + "$" + NF2.format(a);
}

/** Price with sensible decimals; dp forces decimals (FX pairs). */
export function price(p, dp) {
  if (p == null || !isFinite(p)) return "—";
  if (dp != null) return p.toFixed(dp);
  const a = Math.abs(p);
  if (a >= 1000) return "$" + NF2.format(p);
  if (a >= 1) return "$" + p.toFixed(a >= 100 ? 2 : 4).replace(/(\.\d{2}\d*?)0+$/, "$1");
  if (p === 0) return "$0";
  const z = Math.max(0, Math.floor(-Math.log10(a)));
  return "$" + p.toFixed(Math.min(z + 4, 12));
}

export function pct(n, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  return (n > 0 ? "+" : "") + n.toFixed(digits) + "%";
}
export const dirCls = n => (n > 0 ? "up" : n < 0 ? "down" : "flat");

export function qty(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return NF0.format(n);
  if (a >= 1) return nf(0, 4).format(n);
  return n.toPrecision(4);
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
