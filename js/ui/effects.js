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
};

export function confetti(canvas) {
  if (reduced()) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth, H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.hidden = false;
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = ["#20e08a", "#8f7bff", "#ffd166", "#4cc9f0", "#f1f3f8"];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.42, vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 13 - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
    c: cols[(Math.random() * cols.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const el = now - t0;
    g.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.max(0, 1 - el / 2200);
      g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    if (el < 2200) requestAnimationFrame(frame); else { g.clearRect(0, 0, W, H); canvas.hidden = true; }
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
