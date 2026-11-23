// Slide-to-confirm. Drag the thumb to the end to confirm; keyboard users press Enter or Space on it.

export function swipeHTML(side, label) {
  return `<div class="swipe ${side}" data-swipe>
    <div class="swipe-fill"></div>
    <span class="swipe-label">${label}</span>
    <button type="button" class="swipe-thumb" aria-label="${label}. Slide right or press Enter to confirm">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 12h12m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>`;
}

export function bindSwipe(root, onConfirm) {
  const box = root.querySelector("[data-swipe]");
  if (!box) return;
  const thumb = box.querySelector(".swipe-thumb"), fill = box.querySelector(".swipe-fill");
  let startX = 0, dx = 0, dragging = false, done = false;
  const max = () => box.clientWidth - thumb.offsetWidth - 8;
  const set = v => { thumb.style.transform = `translateX(${v}px)`; fill.style.width = `${v + thumb.offsetWidth / 2 + 4}px`; };
  const reset = () => { thumb.style.transition = fill.style.transition = "transform .2s, width .2s"; set(0); setTimeout(() => { thumb.style.transition = fill.style.transition = ""; }, 220); };
  const confirm = () => {
    if (done || box.classList.contains("disabled")) return reset();
    done = true; set(max()); box.classList.add("done");
    Promise.resolve(onConfirm()).finally(() => setTimeout(() => { done = false; box.classList.remove("done"); reset(); }, 350));
  };
  thumb.addEventListener("pointerdown", e => {
    if (box.classList.contains("disabled")) return;
    dragging = true; startX = e.clientX; dx = 0; thumb.setPointerCapture(e.pointerId);
  });
  thumb.addEventListener("pointermove", e => {
    if (!dragging) return;
    dx = Math.max(0, Math.min(max(), e.clientX - startX)); set(dx);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (dx >= max() * 0.85) confirm(); else reset();
  };
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", () => { dragging = false; reset(); });
  thumb.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); confirm(); } });
  thumb.addEventListener("click", e => e.preventDefault());
}

export function setSwipeEnabled(root, on) {
  root.querySelector("[data-swipe]")?.classList.toggle("disabled", !on);
}
