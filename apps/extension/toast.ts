import { browser } from 'wxt/browser';

// Alerts drawn over the video (plan.md decision 87): the background sends every alert to the provider tabs; a
// visible one draws it at the top right of its video — of the fullscreen element in fullscreen (where neither the
// panel nor the toolbar shows), else of the largest <video> in view, else of the page (no video: a home or search
// page); the background sends none while a panel is open (it shows its own).
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
  /** Which alert (a new one for the same friend or room gets another): an answer names it. */
  alertId: number;
  /** A join request this tab showed over a video before it loaded this page: dismissed if this page has none. */
  leftBehind?: boolean;
};
/**
 * This tab shows a join request over a video, or holds one left behind (the background dismisses it if the tab then
 * loads a page without a video).
 */
export const TOAST_OVER_VIDEO = 'mirattic:toast-over-video';
export type ToastOverVideo = { type: typeof TOAST_OVER_VIDEO; target: string; alertId: number };
export type ToastClear = { type: typeof TOAST_CLEAR; seq: number };
/** An alert settled elsewhere (cancelled, answered, expired): off every page. */
export type ToastDismiss = { type: typeof TOAST_DISMISS; kind: AlertKind; target: string; seq: number };
export type ToastAnswer = { type: typeof TOAST_ANSWER; kind: AlertKind; target: string; accept: boolean; alertId?: number };

/** Button labels: [yes, no], in that order left to right. Yes opens the panel too, except on a pause. */
const ANSWERS: Record<AlertKind, [string, string]> = {
  invite: ['입장', '거절'],
  request: ['같이 보기', '무시'],
  pause: ['모두 일시정지', '닫기'],
  answered: ['패널 열기', '닫기'],
};
const FADE_MS = 200;
const READY_DELAY_MS = 2_000;
const RECHECK_MS = 1_000;
const FULLSCREEN_SETTLE_MS = 300; // the new layout, before measuring the video again
const NAVIGATION_SETTLE_MS = 1_000; // the new page's player, before measuring
const VIDEO_FREE_CONFIRM_MS = 2_000; // still no video this much later: the page has none
/** Watch pages of the providers (YouTube, Netflix, Laftel): a video is coming even if its player isn't there yet. */
const WATCH_PAGE = /^\/(watch|shorts\/|live\/|player\/)/;
const MAX_MS = 30_000;
const MIN_VIDEO_WIDTH = 200; // thumbnails and previews aren't "the video"
const MIN_VIDEO_SHARE = 0.4; // of the window's width, likewise

const WIDTH = 300;

/**
 * Where to draw: the element to append to, and the box's position — fixed to the screen in fullscreen, else in
 * the page's coordinates (`absolute`), so it stays on the video when the page scrolls.
 */
type Place = {
  host: Element; position: 'fixed' | 'absolute'; top: number;
  /** From the left (over a video, in its coordinates), or from the right edge (the screen's corner). */
  left?: number; right?: number;
  /** What it sits over (the video, or the fullscreen element); none: the page's corner. */
  over?: Element;
};

function place(panelOpen: boolean): Place | null {
  const fs = document.fullscreenElement;
  // A fullscreen <video> (or frame) renders no children: nothing can show over it (known limit).
  if (fs) {
    if (['VIDEO', 'IFRAME', 'CANVAS', 'IMG'].includes(fs.tagName)) return null;
    return { host: fs, position: 'fixed', top: 24, right: 24, over: fs };
  }
  if (panelOpen) return null;
  // The page's player: shown, and big (not a thumbnail's hover preview or a hidden leftover player).
  const minWidth = Math.max(MIN_VIDEO_WIDTH, innerWidth * MIN_VIDEO_SHARE);
  const [video, rect] = [...document.querySelectorAll('video')]
    .filter((v) => v.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)
    .map((v) => [v, v.getBoundingClientRect()] as const)
    .filter(([, r]) => r.width >= minWidth && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
    .sort(([, a], [, b]) => b.width * b.height - a.width * a.height)[0] ?? [];
  // No video in view (a home or search page, a player still loading): the page's top right, fixed on screen.
  if (!video || !rect) return { host: document.documentElement, position: 'fixed', top: 16, right: 16 };
  // The video's top right corner (its visible part), in page coordinates. ponytail: placed once over a video; one
  // that moves or resizes meanwhile (theater mode) leaves it where the video was.
  return {
    host: document.documentElement,
    position: 'absolute',
    top: Math.max(rect.top, 0) + scrollY + 16,
    left: Math.min(rect.right, innerWidth) + scrollX - WIDTH - 16,
    over: video,
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
  @keyframes left { from { width: var(--from, 100%); } to { width: 0; } }
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
   * The alerts shown, newest on top (by `seq`), one stack per place: over each video (or the fullscreen element),
   * placed where that video was when its first toast came, and at the page's corner when no video was in view. Each is a host element whose closed shadow
   * root the page can't read; a new alert joins the stack for where it goes now and never moves the others (a
   * toast over the video doesn't follow the page's scrolling). A stack goes with its last toast.
   */
  type Stack = { el: HTMLElement; list: HTMLElement };
  const stacks = new Map<Element | 'corner', Stack>();
  const shown = new Map<string, Element>();
  let recheck: ReturnType<typeof setInterval> | undefined;
  const stopRecheck = () => {
    clearInterval(recheck);
    recheck = undefined;
  };
  const clear = () => {
    for (const stack of stacks.values()) stack.el.remove();
    stacks.clear();
    shown.clear();
    stopRecheck();
    clearInterval(navWatch);
    navWatch = undefined;
  };
  /** Their place is gone (fullscreen switched, another page): off, then drawn again for the time they have left. */
  const redraw = (settleMs: number, then = () => {}) => {
    clear();
    setTimeout(() => {
      then();
      void browser.runtime.sendMessage({ type: TOAST_READY }).catch(() => {});
    }, settleMs);
  };
  // A site that changes pages without loading one (YouTube): while any shows, a new address redraws them.
  let navWatch: ReturnType<typeof setInterval> | undefined;
  /**
   * Join requests left behind on the way from a page with a video to pages without: dismissed ("무시") once a page
   * is surely without a video — they can't be taken up there. Kept across further moves between such pages; a
   * video appearing (or the request settling: its toast comes back or goes) ends it.
   */
  /** key → the alert it was shown for: a newer alert for the same key isn't the one left behind. */
  let declining = new Map<string, number>();
  /** The latest alert received for each key: one left behind is dismissed only if nothing newer came since. */
  const latest = new Map<string, number>();
  const stillLatest = (key: string, alertId: number) => latest.get(key) === alertId;
  let declineTimer: ReturnType<typeof setTimeout> | undefined;
  // Only a page that is surely without a video: not a watch page (its player may still be loading).
  const noVideo = () => !WATCH_PAGE.test(location.pathname) && !place(false)?.over;
  /**
   * Dismisses these left-behind requests unless a video shows here: decided when the confirmation ends (an old
   * player may linger at first, a new one may come late).
   */
  const scheduleDecline = (requests: Map<string, number>) => {
    for (const [key, alertId] of requests) declining.set(key, alertId);
    clearTimeout(declineTimer);
    declineTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') {
        // A tab in the background: decided once it is looked at (the same confirmation from then).
        document.addEventListener('visibilitychange', () => declining.size && scheduleDecline(new Map()), { once: true });
        return;
      }
      const due = declining;
      declining = new Map();
      if (!noVideo()) return; // a video came after all
      for (const [key, alertId] of due) {
        if (!stillLatest(key, alertId)) continue; // a new request from that friend came meanwhile
        const target = key.slice('request:'.length);
        const answer: ToastAnswer = { type: TOAST_ANSWER, kind: 'request', target, accept: false, alertId };
        void browser.runtime.sendMessage(answer).catch(() => {});
      }
    }, VIDEO_FREE_CONFIRM_MS);
  };
  /** A request shown over a video here: the background remembers it for this tab's next page load. */
  const reportOverVideo = (key: string, alertId: number) => {
    if (!key.startsWith('request:')) return;
    const message: ToastOverVideo = { type: TOAST_OVER_VIDEO, target: key.slice('request:'.length), alertId };
    void browser.runtime.sendMessage(message).catch(() => {});
  };
  const watchNavigation = () => {
    if (navWatch) return;
    let at = location.href;
    navWatch = setInterval(() => {
      if (location.href === at) return;
      at = location.href;
      const hadVideo = [...stacks.keys()].some((where) => where !== 'corner') || declining.size > 0;
      const requests = new Map(declining);
      for (const [key, box] of shown) {
        if (key.startsWith('request:')) requests.set(key, Number((box as HTMLElement).dataset.alertId));
      }
      clearTimeout(declineTimer);
      declining = new Map();
      // Other alerts are drawn again where they now go; the requests too, until they are dismissed.
      redraw(NAVIGATION_SETTLE_MS, () => {
        for (const [key, alertId] of requests) if (!stillLatest(key, alertId)) requests.delete(key);
        if (!hadVideo || !requests.size) return;
        scheduleDecline(requests);
      });
    }, RECHECK_MS);
  };
  /** A stack's toasts gone: so is the stack (and the corner's recheck). */
  const tidy = () => {
    for (const [where, stack] of stacks) {
      if (stack.list.childElementCount) continue;
      stack.el.remove();
      stacks.delete(where);
      if (where === 'corner') stopRecheck();
    }
    if (!stacks.size) {
      clearInterval(navWatch); // none shows: no page change to follow
      navWatch = undefined;
    }
  };
  /** The bar runs from the share of the alert's 30 s still left (drawn again or moved, it doesn't start over). */
  const startBar = (box: HTMLElement) => {
    const left = Math.max(0, Number(box.dataset.until) - Date.now());
    const bar = box.querySelector('.bar > i') as HTMLElement;
    bar.style.setProperty('--from', `${(left / MAX_MS) * 100}%`);
    bar.style.animationDuration = `${left}ms`;
  };
  /** Into a stack by arrival, newest first (a merge keeps that order too). */
  const insert = (list: HTMLElement, box: HTMLElement) => {
    const seq = Number(box.dataset.seq);
    const after = [...list.children].find((c) => Number((c as HTMLElement).dataset.seq) < seq);
    list.insertBefore(box, after ?? null);
  };
  const stackAt = (at: Place) => {
    const where = at.over ?? 'corner';
    let stack = stacks.get(where);
    if (!stack) {
      const el = document.createElement('div');
      const root = el.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${STYLE}</style><div class="stack"></div>`;
      stack = { el, list: root.querySelector('.stack')! as HTMLElement };
      Object.assign(stack.list.style, {
        position: at.position,
        top: `${at.top}px`,
        left: at.left === undefined ? '' : `${at.left}px`,
        right: at.right === undefined ? '' : `${at.right}px`,
      });
      watchNavigation();
      at.host.append(el);
      stacks.set(where, stack);
    }
    // At the corner (no video yet): looked at again each second, and onto the video once one shows.
    if (where === 'corner') {
      recheck ??= setInterval(() => {
        const now = place(false);
        const corner = stacks.get('corner');
        if (!now?.over || !corner) return;
        const video = stackAt(now);
        for (const box of [...corner.list.children] as HTMLElement[]) {
          startBar(box); // moving it restarts its animation: from the time it has left
          insert(video.list, box);
          reportOverVideo(box.dataset.key!, Number(box.dataset.alertId));
        }
        tidy();
      }, RECHECK_MS);
    }
    return stack;
  };
  /** Fades one out; its stack goes with its last. */
  const remove = (key: string) => {
    const box = shown.get(key);
    if (!box) return;
    shown.delete(key);
    box.classList.add('out');
    setTimeout(() => {
      box.remove();
      tidy();
    }, FADE_MS);
  };
  // Their place is gone either way: drawn again where they now go, for the time they have left.
  document.addEventListener('fullscreenchange', () => redraw(FULLSCREEN_SETTLE_MS));

  /** Draws it over the video (or the page's top right); false when it can't (a fullscreen <video>, a panel open). */
  function show(m: ToastMessage): boolean {
    const at = place(m.panelOpen === true);
    if (!at) return false;
    const stack = stackAt(at);
    const key = keyOf(m);
    shown.get(key)?.remove(); // the same alert again (a page replaying it): once
    const ms = Number.isFinite(m.ms) && m.ms > 0 ? Math.min(m.ms, MAX_MS) : MAX_MS;
    const box = document.createElement('div');
    box.className = 'toast';
    box.dataset.seq = String(m.seq);
    box.dataset.alertId = String(m.alertId);
    box.dataset.key = key;
    box.setAttribute('role', 'alertdialog');
    box.innerHTML = `<div class="text"><b></b><span class="meta"></span><span class="body"></span></div>
      <div class="actions"></div><div class="bar" role="progressbar" aria-label="자동으로 닫힘"><i></i></div>`;
    box.querySelector('b')!.textContent = m.title;
    box.querySelector('.meta')!.textContent = m.meta ?? '';
    box.querySelector('.body')!.textContent = m.body;
    box.dataset.until = String(Date.now() + ms);
    startBar(box);
    ANSWERS[m.kind].forEach((label, i) => {
      const button = document.createElement('button');
      button.textContent = label;
      if (i === 1) button.className = 'no';
      button.addEventListener('click', () => {
        const answer: ToastAnswer = { type: TOAST_ANSWER, kind: m.kind, target: m.target, accept: i === 0, alertId: m.alertId };
        void browser.runtime.sendMessage(answer).catch(() => {});
        if (shown.get(key) === box) remove(key);
      });
      box.querySelector('.actions')!.append(button);
    });
    // The bar running out closes it (the box's own fade-in ends too: only the bar's counts).
    box.querySelector('.bar > i')!.addEventListener('animationend', () => shown.get(key) === box && remove(key));
    insert(stack.list, box);
    shown.set(key, box);
    tidy(); // the same alert's earlier box may have left a stack empty
    return true;
  }

  /** The last clear, and the last dismissal of each alert: a toast sent before them is stale. */
  let clearedAt = 0;
  const dismissedAt = new Map<string, number>();

  browser.runtime.onMessage.addListener((m: ToastMessage | ToastDismiss | ToastClear, sender) => {
    if (sender.id !== browser.runtime.id || typeof m?.seq !== 'number') return;
    if (m.type === TOAST_CLEAR) {
      clearedAt = Math.max(clearedAt, m.seq);
      clearTimeout(declineTimer); // none of them is left behind any more (a panel opened, signed out)
      declining = new Map();
      return clear();
    }
    if (m.type === TOAST_DISMISS) {
      dismissedAt.set(keyOf(m), Math.max(dismissedAt.get(keyOf(m)) ?? 0, m.seq));
      return void remove(keyOf(m)); // settled elsewhere: no longer answerable
    }
    if (m.type !== TOAST || !(m.kind in ANSWERS)) return;
    if (m.seq < clearedAt || m.seq < (dismissedAt.get(keyOf(m)) ?? 0)) return; // overtaken by its clear or dismissal
    // A newer alert for the same one (a new request from that friend): not the one left behind on another page.
    latest.set(keyOf(m), m.alertId);
    if (declining.has(keyOf(m)) && declining.get(keyOf(m)) !== m.alertId) declining.delete(keyOf(m));
    const drawn = show(m);
    const overAVideo = drawn && [...stacks].some(([where, stack]) => where !== 'corner' && stack.list.contains(shown.get(keyOf(m)) ?? null));
    // One left behind is reported too, video or not: the background keeps it with this page until it is decided here
    // (leaving before that, the next page decides).
    if (overAVideo || (m.leftBehind && m.kind === 'request')) reportOverVideo(keyOf(m), m.alertId);
    if (m.leftBehind && m.kind === 'request') scheduleDecline(new Map([[keyOf(m), m.alertId]]));
  });
}

