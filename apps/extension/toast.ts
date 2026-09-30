import { browser } from 'wxt/browser';

// Alerts drawn over the video (plan.md decision 87): the background sends every alert to the provider tabs; a
// visible one draws it at the top right of its video — of the fullscreen element in fullscreen (where neither the
// panel nor the toolbar shows), else of the largest <video> in view, unless a panel is open (it shows its own).
// In a shadow root so the page's styles don't reach it, with the alert's two answers, which the background carries
// out as the panel would. It reads nothing from the page but whether it is fullscreen and where its <video> are.
// A page loaded while an alert still counts (the room's video opened on entering) asks for it (`TOAST_READY`).

export const TOAST = 'mirattic:toast';
export const TOAST_ANSWER = 'mirattic:toast-answer';
export const TOAST_READY = 'mirattic:toast-ready';
export const TOAST_DISMISS = 'mirattic:toast-dismiss';
/** Every toast off the page: a panel opened (it shows them), signed out. */
export const TOAST_CLEAR = 'mirattic:toast-clear';

/**
 * `target`: the room (invite, pause, answered) or the friend who asked (request). `answered`: the friend I asked
 * invited me, and the background entered the room; its button opens the panel.
 */
export type AlertKind = 'invite' | 'request' | 'pause' | 'answered';
/**
 * `ms`: how long it shows (the alert's time, decision 87: 30 s). `meta`: where to watch ("YouTube · channel").
 * `seq` (every message to the pages): rising in send order, so one overtaken by a later clear or dismissal is
 * dropped on arrival.
 */
export type ToastMessage = {
  type: typeof TOAST; kind: AlertKind; target: string; ms: number; title: string; meta?: string; body: string;
  panelOpen: boolean; seq: number;
};
export type ToastClear = { type: typeof TOAST_CLEAR; seq: number };
/** An alert settled elsewhere (cancelled, answered, expired): off every page. */
export type ToastDismiss = { type: typeof TOAST_DISMISS; kind: AlertKind; target: string; seq: number };
export type ToastAnswer = { type: typeof TOAST_ANSWER; kind: AlertKind; target: string; accept: boolean };

/** Button labels: [yes, no], in that order left to right. Yes opens the panel too, except on a pause. */
const ANSWERS: Record<AlertKind, [string, string]> = {
  invite: ['입장', '거절'],
  request: ['같이 보기', '무시'],
  pause: ['모두 일시정지', '닫기'],
  answered: ['패널 열기', '닫기'],
};
const FADE_MS = 200;
const READY_DELAY_MS = 2_000;
const RETRY_MS = 1_000;
const FULLSCREEN_SETTLE_MS = 300; // the new layout, before measuring the video again
const MAX_MS = 30_000;
const MIN_VIDEO_WIDTH = 200; // thumbnails and previews aren't "the video"

const WIDTH = 300;

/**
 * Where to draw: the element to append to, and the box's position — fixed to the screen in fullscreen, else in
 * the page's coordinates (`absolute`), so it stays on the video when the page scrolls.
 */
function place(panelOpen: boolean): { host: Element; position: 'fixed' | 'absolute'; top: number; left: number } | null {
  const fs = document.fullscreenElement;
  // A fullscreen <video> (or frame) renders no children: nothing can show over it (known limit).
  if (fs) {
    if (['VIDEO', 'IFRAME', 'CANVAS', 'IMG'].includes(fs.tagName)) return null;
    return { host: fs, position: 'fixed', top: 24, left: innerWidth - WIDTH - 24 };
  }
  if (panelOpen) return null;
  const rect = [...document.querySelectorAll('video')]
    .map((v) => v.getBoundingClientRect())
    .filter((r) => r.width >= MIN_VIDEO_WIDTH && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!rect) return null;
  // The video's top right corner (its visible part), in page coordinates. ponytail: placed once; a player that
  // moves or resizes meanwhile (theater mode) leaves it where the video was.
  return {
    host: document.documentElement,
    position: 'absolute',
    top: Math.max(rect.top, 0) + scrollY + 16,
    left: Math.min(rect.right, innerWidth) + scrollX - WIDTH - 16,
  };
}

const STYLE = `
  .stack { z-index: 2147483647; width: ${WIDTH}px; display: flex; flex-direction: column; gap: 8px; }
  .toast {
    --fg: #1c1c1e; --surface: #ffffff; --muted: #7a7a80; --line: #e6e5e1; --hover: #efeeea;
    --strong: #1c1c1e; --on-strong: #ffffff; --accent: #3f6b5a;
    box-sizing: border-box; overflow: hidden; border: 1px solid var(--line); border-radius: 12px;
    background: var(--surface); color: var(--fg); box-shadow: 0 12px 32px rgb(0 0 0 / 0.18);
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Segoe UI", system-ui, sans-serif;
    font-size: 13px; line-height: 1.45; text-align: left;
    animation: in ${FADE_MS}ms ease-out; transition: opacity ${FADE_MS}ms ease-in;
  }
  @media (prefers-color-scheme: dark) {
    .toast { --fg: #ececea; --surface: #202020; --muted: #9b9b98; --line: #2e2e2d; --hover: #2a2a29;
      --strong: #ececea; --on-strong: #171717; --accent: #8cc4a8; }
  }
  .toast.out { opacity: 0; }
  @keyframes in { from { opacity: 0; } }
  .text { padding: 14px 16px 0; }
  b { display: block; font-size: 14px; font-weight: 600; }
  span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  span.meta { margin-top: 2px; }
  span:empty { display: none; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 12px 16px 14px; }
  button { width: 100%; margin: 0; padding: 6px 12px; border: 1px solid transparent; border-radius: 7px;
    font: inherit; font-weight: 550; cursor: pointer; background: var(--strong); color: var(--on-strong); }
  button.no { background: transparent; color: var(--fg); border-color: var(--line); }
  button.no:hover { background: var(--hover); }
  /* Time left until it closes (the alert's own time: hovering doesn't hold it). */
  .bar { height: 3px; background: var(--line); }
  .bar > i { display: block; height: 100%; background: var(--accent); animation: left linear forwards; }
  @keyframes left { from { width: 100%; } to { width: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; transition: none; }
    .bar > i { animation-timing-function: steps(30); }
  }
`;

const keyOf = (m: { kind: AlertKind; target: string }) => `${m.kind}:${m.target}`;

export function serveToast() {
  // ponytail: asked once, a moment after load (the player's <video> comes late); a later one misses it.
  setTimeout(() => void browser.runtime.sendMessage({ type: TOAST_READY }).catch(() => {}), READY_DELAY_MS);
  /**
   * The alerts shown, stacked newest on top in one host element whose closed shadow root the page can't read;
   * placed when the first one comes, gone with the last.
   */
  let stack: { el: HTMLElement; list: Element } | null = null;
  const shown = new Map<string, Element>();
  const clear = () => {
    stack?.el.remove();
    stack = null;
    shown.clear();
  };
  /** Fades one out; the stack goes with the last. */
  const remove = (key: string) => {
    const box = shown.get(key);
    if (!box) return;
    shown.delete(key);
    box.classList.add('out');
    const from = stack;
    setTimeout(() => {
      box.remove();
      if (stack === from && !shown.size) clear();
    }, FADE_MS);
  };
  // Their place is gone either way: drawn again where they now go, for the time they have left.
  document.addEventListener('fullscreenchange', () => {
    clear();
    setTimeout(() => void browser.runtime.sendMessage({ type: TOAST_READY }).catch(() => {}), FULLSCREEN_SETTLE_MS);
  });

  /** Alerts with no place yet, retried until they stop counting. */
  const waiting = new Map<string, { m: ToastMessage; until: number }>();
  let retry: ReturnType<typeof setInterval> | undefined;

  /** Draws it where the video is now; false when there is no place for it (no video in view yet). */
  function show(m: ToastMessage): boolean {
    const at = place(m.panelOpen === true);
    if (!at) return false;
    if (!stack) {
      const el = document.createElement('div');
      const root = el.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${STYLE}</style><div class="stack"></div>`;
      const list = root.querySelector('.stack')! as HTMLElement;
      Object.assign(list.style, { position: at.position, top: `${at.top}px`, left: `${at.left}px` });
      at.host.append(el);
      stack = { el, list };
    }
    const key = keyOf(m);
    shown.get(key)?.remove(); // the same alert again (a page replaying it): once
    const ms = Number.isFinite(m.ms) && m.ms > 0 ? Math.min(m.ms, MAX_MS) : MAX_MS;
    const box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'alertdialog');
    box.innerHTML = `<div class="text"><b></b><span class="meta"></span><span class="body"></span></div>
      <div class="actions"></div><div class="bar" role="progressbar" aria-label="자동으로 닫힘"><i></i></div>`;
    box.querySelector('b')!.textContent = m.title;
    box.querySelector('.meta')!.textContent = m.meta ?? '';
    box.querySelector('.body')!.textContent = m.body;
    (box.querySelector('.bar > i') as HTMLElement).style.animationDuration = `${ms}ms`;
    ANSWERS[m.kind].forEach((label, i) => {
      const button = document.createElement('button');
      button.textContent = label;
      if (i === 1) button.className = 'no';
      button.addEventListener('click', () => {
        const answer: ToastAnswer = { type: TOAST_ANSWER, kind: m.kind, target: m.target, accept: i === 0 };
        void browser.runtime.sendMessage(answer).catch(() => {});
        if (shown.get(key) === box) remove(key);
      });
      box.querySelector('.actions')!.append(button);
    });
    // The bar running out closes it (the box's own fade-in ends too: only the bar's counts).
    box.querySelector('.bar > i')!.addEventListener('animationend', () => shown.get(key) === box && remove(key));
    stack.list.prepend(box);
    shown.set(key, box);
    return true;
  }

  /** The last clear, and the last dismissal of each alert: a toast sent before them is stale. */
  let clearedAt = 0;
  const dismissedAt = new Map<string, number>();

  browser.runtime.onMessage.addListener((m: ToastMessage | ToastDismiss | ToastClear, sender) => {
    if (sender.id !== browser.runtime.id || typeof m?.seq !== 'number') return;
    if (m.type === TOAST_CLEAR) {
      clearedAt = Math.max(clearedAt, m.seq);
      waiting.clear();
      return clear();
    }
    if (m.type === TOAST_DISMISS) {
      dismissedAt.set(keyOf(m), Math.max(dismissedAt.get(keyOf(m)) ?? 0, m.seq));
      waiting.delete(keyOf(m));
      return void remove(keyOf(m)); // settled elsewhere: no longer answerable
    }
    if (m.type !== TOAST || !(m.kind in ANSWERS)) return;
    if (m.seq < clearedAt || m.seq < (dismissedAt.get(keyOf(m)) ?? 0)) return; // overtaken by its clear or dismissal
    waiting.delete(keyOf(m));
    if (show(m)) return;
    // No video in view yet (a player still loading): tried again each second while it counts.
    waiting.set(keyOf(m), { m, until: Date.now() + (Number.isFinite(m.ms) && m.ms > 0 ? Math.min(m.ms, MAX_MS) : MAX_MS) });
    retry ??= setInterval(() => {
      for (const [key, w] of waiting) {
        const left = w.until - Date.now();
        if (left <= 0 || show({ ...w.m, ms: left })) waiting.delete(key);
      }
      if (!waiting.size) {
        clearInterval(retry);
        retry = undefined;
      }
    }, RETRY_MS);
  });
}

