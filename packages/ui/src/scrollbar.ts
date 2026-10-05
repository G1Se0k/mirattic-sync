// A floating scrollbar (App.css: .scroll-thumb), as native ones are hidden: shown over a scroller while the user scrolls it,
// gone 800 ms after it stops. A scroll counts as the user's within 500 ms of their wheel, touch or scroll key inside that
// scroller (or a key with nothing focused); then it stays up through momentum. The panel's own scrolls (the chat following
// new lines) don't show it. The thumb can be dragged.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const opts = { capture: true, passive: true };
const thumb = document.createElement("div");
thumb.className = "scroll-thumb";
let inputAt = -Infinity;
let inputOn: Node | null = null;
let on: Element | null = null; // the scroller the thumb is showing on
let hideTimer = 0;
let drag: { y: number; top: number } | null = null;

const mark = (e: Event) => { inputAt = performance.now(); inputOn = e.target as Node; };
addEventListener("wheel", mark, opts);
addEventListener("touchmove", mark, opts);
addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (SCROLL_KEYS.has(e.key) && !t?.closest?.("input, textarea, [contenteditable]")) mark(e);
}, opts);

/** The thumb's length and how far it moves per pixel scrolled. */
function metrics(el: Element) {
  const len = Math.max(24, (el.clientHeight * el.clientHeight) / el.scrollHeight);
  return { len, ratio: (el.clientHeight - len) / (el.scrollHeight - el.clientHeight) };
}

function show(el: Element) {
  if (el.scrollHeight <= el.clientHeight) return;
  const page = el === document.documentElement;
  const r = page ? { top: 0, right: el.clientWidth } : el.getBoundingClientRect();
  const { len, ratio } = metrics(el);
  thumb.style.top = `${r.top + (page ? 0 : el.clientTop) + el.scrollTop * ratio}px`;
  thumb.style.left = `${r.right - 8}px`;
  thumb.style.height = `${len}px`;
  thumb.classList.toggle("page", page);
  thumb.classList.add("on");
  if (!thumb.isConnected) document.body.append(thumb);
  on = el;
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => { if (!drag) { thumb.classList.remove("on"); on = null; } }, 800);
}

addEventListener("scroll", (e) => {
  const el = e.target instanceof Element ? e.target : document.documentElement;
  const byUser = performance.now() - inputAt <= 500 && (inputOn === document.body || el.contains(inputOn));
  if (byUser || el === on) show(el);
}, opts);

thumb.addEventListener("pointerdown", (e) => {
  if (!on) return;
  drag = { y: e.clientY, top: on.scrollTop };
  thumb.setPointerCapture(e.pointerId);
  thumb.classList.add("drag");
  e.preventDefault();
});
thumb.addEventListener("pointermove", (e) => {
  if (drag && on) on.scrollTop = drag.top + (e.clientY - drag.y) / metrics(on).ratio;
});
const endDrag = () => {
  drag = null;
  thumb.classList.remove("drag");
  if (on) show(on);
};
thumb.addEventListener("pointerup", endDrag);
thumb.addEventListener("pointercancel", endDrag);
