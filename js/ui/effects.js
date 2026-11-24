// Celebration and feedback: confetti, shake, big result, vibration (Android), optional sounds.

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function vibrate(pattern) {
  try { if ("vibrate" in navigator) navigator.vibrate(pattern); } catch {}
}

let actx = null;
function tone(freqs, { dur = 0.09, type = "triangle", gain = 0.06 } = {}) {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.9;
    }
  } catch {}
}
export const sounds = {
  win: () => tone([523, 659, 784, 1047], { dur: 0.1 }),
  loss: () => tone([330, 247, 196], { dur: 0.14, type: "sawtooth", gain: 0.04 }),
  fill: () => tone([880, 1175], { dur: 0.07 }),
  tap: () => tone([660], { dur: 0.04, gain: 0.03 }),
  // Sim mode
  buy: () => tone([523, 784], { dur: 0.06 }),
  sell: () => tone([784, 523], { dur: 0.06 }),
  pump: () => tone([392, 523, 659, 784, 1047, 1319], { dur: 0.07, type: "square", gain: 0.035 }),
  rug: () => tone([440, 349, 262, 196, 131], { dur: 0.16, type: "sawtooth", gain: 0.05 }),
  jackpot: () => { tone([523, 659, 784, 1047, 784, 1047, 1319, 1568], { dur: 0.09, type: "square", gain: 0.04 }); },
  event: () => tone([880, 660, 880, 660], { dur: 0.12, type: "square", gain: 0.04 }),
};

export function confetti(canvas, { big = false } = {}) {
  if (reduced()) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth, H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.hidden = false;
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = big ? ["#ffd166", "#ffb547", "#20e08a", "#ff5fd2", "#8f7bff", "#f1f3f8"] : ["#20e08a", "#8f7bff", "#ffd166", "#4cc9f0", "#f1f3f8"];
  const parts = Array.from({ length: big ? 420 : 140 }, () => ({
    x: big ? Math.random() * W : W / 2 + (Math.random() - 0.5) * 80, y: big ? H * (0.2 + Math.random() * 0.5) : H * 0.42,
    vx: (Math.random() - 0.5) * (big ? 18 : 13), vy: -Math.random() * (big ? 17 : 13) - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
    c: cols[(Math.random() * cols.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const el = now - t0;
    g.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.max(0, 1 - el / (big ? 3400 : 2200));
      g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    if (el < (big ? 3400 : 2200)) requestAnimationFrame(frame); else { g.clearRect(0, 0, W, H); canvas.hidden = true; }
  })(t0);
}

export function shake(el) {
  if (reduced()) return;
  el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 500);
}

/** Big full-screen result: +$123.45 in green or -$12.00 in red. */
export function bigResult(el, { text, sub, win }) {
  el.innerHTML = `<div class="res-box ${win ? "win" : "loss"}"><b>${text}</b><small>${sub || ""}</small></div>`;
  el.hidden = false;
  clearTimeout(bigResult.t);
  bigResult.t = setTimeout(() => { el.hidden = true; }, 2200);
  el.onclick = () => { el.hidden = true; };
}

/** Slot-machine count: the number spins from `from` to `to` (digits blur while they roll). */
export function rollNumber(el, from, to, fmt, ms = 700) {
  if (reduced() || from == null || !isFinite(from) || from === to) { el.textContent = fmt(to); return; }
  cancelAnimationFrame(el._roll);
  const t0 = performance.now();
  el.classList.add("rolling");
  const frame = now => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) el._roll = requestAnimationFrame(frame);
    else { el.textContent = fmt(to); el.classList.remove("rolling"); }
  };
  el._roll = requestAnimationFrame(frame);
}

/** Full-screen JACKPOT: big multiple, coin rain behind it. */
export function jackpot(el, { mult, sym, usd }) {
  el.innerHTML = `<div class="jp-box"><span class="jp-coins" aria-hidden="true">🪙💰🪙</span><b>JACKPOT</b><strong>${mult}</strong><small>${sym} · ${usd}</small></div>`;
  el.hidden = false;
  clearTimeout(jackpot.t);
  jackpot.t = setTimeout(() => { el.hidden = true; }, 3600);
  el.onclick = () => { el.hidden = true; };
}
