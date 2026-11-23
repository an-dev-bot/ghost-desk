// Candlestick / line chart on a canvas. Redrawn on every live tick (cheap: at most ~120 bars).

import { price } from "./format.js";

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export function drawChart(canvas, bars, { mode = "candles", dp, ivl = "1m", empty = "" } = {}) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 300, H = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const up = cssVar("--up"), down = cssVar("--down"), muted = cssVar("--muted"), line = cssVar("--line"), fg = cssVar("--fg");
  const mono = cssVar("--mono") || "monospace";

  if (!bars || bars.length < 2) {
    g.fillStyle = muted; g.font = `12px ${mono}`; g.textAlign = "center";
    wrapText(g, empty || "Esperando precios en vivo…", W / 2, H / 2 - 8, W - 32, 16);
    return;
  }
  const right = 62, bottom = 18, top = 10, left = 6;
  const plotW = W - left - right, plotH = H - top - bottom;
  const maxBars = Math.max(20, Math.min(150, Math.floor(plotW / 6)));
  const view = bars.slice(-maxBars);
  let lo = Infinity, hi = -Infinity;
  for (const b of view) { if (mode === "line") { lo = Math.min(lo, b.c); hi = Math.max(hi, b.c); } else { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); } }
  if (hi === lo) { hi *= 1.001; lo *= 0.999; }
  const pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
  const y = v => top + (hi - v) / (hi - lo) * plotH;
  const step = plotW / view.length;
  const x = i => left + step * i + step / 2;

  // grid + price labels (skipping the one the last-price tag would cover)
  const last = view[view.length - 1];
  const ly = y(last.c);
  g.strokeStyle = line; g.lineWidth = 1; g.fillStyle = muted; g.font = `10px ${mono}`; g.textAlign = "left"; g.textBaseline = "middle";
  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * (k / 3);
    const yy = Math.round(y(v)) + 0.5;
    g.beginPath(); g.moveTo(left, yy); g.lineTo(left + plotW, yy); g.stroke();
    if (Math.abs(yy - ly) > 16) g.fillText(short(v, dp), left + plotW + 6, yy);
  }

  const rising = last.c >= view[0].o;
  if (mode === "line") {
    const col = rising ? up : down;
    g.beginPath();
    view.forEach((b, i) => (i ? g.lineTo(x(i), y(b.c)) : g.moveTo(x(i), y(b.c))));
    g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = "round"; g.stroke();
    g.lineTo(x(view.length - 1), top + plotH); g.lineTo(x(0), top + plotH); g.closePath();
    const grad = g.createLinearGradient(0, top, 0, top + plotH);
    grad.addColorStop(0, hexA(col, 0.28)); grad.addColorStop(1, hexA(col, 0));
    g.fillStyle = grad; g.fill();
  } else {
    const bw = Math.max(1, Math.min(10, step * 0.66));
    view.forEach((b, i) => {
      const col = b.c >= b.o ? up : down;
      const cx = Math.round(x(i)) + 0.5;
      g.strokeStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, y(b.h)); g.lineTo(cx, y(b.l)); g.stroke();
      const y1 = y(Math.max(b.o, b.c)), y2 = y(Math.min(b.o, b.c));
      g.fillStyle = col; g.fillRect(cx - bw / 2, y1, bw, Math.max(1, y2 - y1));
    });
  }

  // last price line + tag
  const col = last.c >= last.o ? up : down;
  g.setLineDash([3, 3]); g.strokeStyle = col; g.beginPath(); g.moveTo(left, ly); g.lineTo(left + plotW, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = col; roundRect(g, left + plotW + 2, ly - 9, right - 4, 18, 4); g.fill();
  g.fillStyle = cssVar("--bg"); g.font = `600 10px ${mono}`; g.fillText(short(last.c, dp), left + plotW + 6, ly);

  // time labels
  g.fillStyle = muted; g.font = `10px ${mono}`; g.textBaseline = "alphabetic";
  g.textAlign = "left"; g.fillText(timeLabel(view[0].t, ivl), left, H - 4);
  g.textAlign = "right"; g.fillText(timeLabel(last.t, ivl), left + plotW, H - 4);
  g.fillStyle = fg;
}

function short(v, dp) {
  if (dp != null) return v.toFixed(dp);
  return price(v).replace("$", "");
}
function timeLabel(t, ivl) {
  const d = new Date(t);
  if (ivl === "1d") return d.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}
function hexA(col, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function wrapText(g, text, cx, cy, maxW, lh) {
  const words = text.split(" "); const lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  lines.forEach((l, i) => g.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * lh));
}
