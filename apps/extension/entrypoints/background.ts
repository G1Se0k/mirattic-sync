import { browser, type Browser } from 'wxt/browser';
import { ApiError, connectSocket, createApi, type ApiClient, type Socket, type SocketStatus } from '@mirattic/client';
import { PAUSE_REQUEST_SHOWN_MS, RoomSync } from '@mirattic/sync-core';
import {
  INCOMING_MS, PROVIDER_NAMES, roomToInvite, type IncomingRequest, type MediaProvider, type RoomContent, type RoomView, type ServerEvent,
} from '@mirattic/types';
import { API_URL, SOCKET_URL, authorize, store } from '../session';
import { hasConsent } from '../consent';
import { SITE_HOME, watch, type Watch } from '../watch';
import {
  TOAST, TOAST_ANSWER, TOAST_CLEAR, TOAST_DISMISS, TOAST_OVER_VIDEO, TOAST_READY,
  type AlertKind, type ToastAnswer, type ToastClear, type ToastDismiss, type ToastMessage, type ToastOverVideo,
} from '../toast';
import { ROOM_ACTIONS, UI_PORT, type FromPanel, type Shared, type ToPanel } from '../ui-port';

// The extension's engine (plan.md decision 69): signed-in session, socket, presence, the followed tab and the
// room's sync live here, not in the side panel, so closing the panel neither breaks the sync nor leaves the room.
// An open WebSocket that exchanges messages keeps a Chrome 116+ service worker alive: a keepalive goes out
// every 20 seconds. Only "방 나가기" (or the room closing) takes the user out of the room.

const KEEPALIVE_MS = 20_000;
const LOOKUP_MS = 1_500; // a lookup for an alert's details, at most (`within`)
const ROOM_KEY = 'mirattic.room'; // storage.session: back into the room if the worker restarts
// storage.local: closure notices not shown yet survive a worker or browser restart (cleared on sign-out)
const CLOSED_ROOMS_ITEM = 'mirattic.closedRooms';
// storage.local: another device took over (decision 89); no connecting (worker or browser restart included) until
// the user presses "여기서 계속" here.
const REPLACED_FLAG = 'mirattic.replaced';
const PROVIDER_ORIGINS = ['https://www.youtube.com/', 'https://www.netflix.com/', 'https://laftel.net/'];
const PROVIDER_TABS = PROVIDER_ORIGINS.map((o) => `${o}*`);
/** `until`: when it stops counting. */
type Alert = { kind: AlertKind; target: string; title: string; toast: Omit<ToastMessage, 'seq'>; until: number };

/** storage.local (+ ".<userId>"): rooms whose type changes are confirmed without asking (decision 93, "이 방에서는 항상 허용하기"). */
const TYPE_ALWAYS_ITEM = 'mirattic.typeAlways';
const latestPanelEntry = 'mirattic.latestPanel'; // storage.session: the latest opened side panel (decision 94)
const roomSiteEntry = 'mirattic.roomSite'; // storage.session: the room's site while in one (decision 94)
const PANEL_OFFER_MS = 10_000; // "패널 열기" over another window's video (decision 95)
const TYPE_RETRY_MS = 60_000; // a failed confirmation: asked instead, automatic again after this

export default defineBackground(() => {
  // Toolbar icon opens the side panel (outside the page, never over the player).
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  const api = createApi({ baseUrl: API_URL, store, authorize });
  const ports = new Set<Browser.runtime.Port>();
  /** Each panel's window and when it opened (one window has the panel, decision 94). */
  const panelWindows = new Map<Browser.runtime.Port, { openedAt: number; windowId?: number }>();
  /** The latest opened panel, in storage.session: a worker restarting meanwhile still knows which one wins. */
  type LatestPanel = { openedAt: number; windowId?: number };
  let latestPanelMemo: Promise<LatestPanel | null> | null = null;
  const latestPanel = () => (latestPanelMemo ??= browser.storage.session.get(latestPanelEntry)
    .then((v) => (v[latestPanelEntry] as LatestPanel | undefined) ?? null, () => null));
  const setLatestPanel = async (p: LatestPanel) => {
    latestPanelMemo = Promise.resolve(p);
    await browser.storage.session.set({ [latestPanelEntry]: p }).catch(() => {});
  };
  let panelTurn: Promise<unknown> = Promise.resolve();
  /** @returns whether this panel stays: false = an older one than the latest of another window (told to close). */
  async function arbitrate(port: Browser.runtime.Port, openedAt: number, windowId: number | undefined) {
    const me = { openedAt, windowId };
    const latest = await latestPanel();
    if (latest && latest.windowId !== windowId && newerPanel(latest, me)) {
      post(port, { kind: 'close' });
      return false;
    }
    if (!latest || !newerPanel(latest, me)) await setLatestPanel(me);
    panelWindows.set(port, me);
    for (const [other, p] of panelWindows) {
      if (other !== port && p.windowId !== windowId && newerPanel(me, p)) {
        panelAllowed.set(other, Promise.resolve(false)); // nothing more from it, already (it is closing)
        lostTo.set(other, { windowId, at: Date.now() });
        post(other, { kind: 'close' });
      }
    }
    return true;
  }
  /** Opened later — the same millisecond decided by the window id, so two windows never both win. */
  const newerPanel = (a: LatestPanel, b: LatestPanel) =>
    a.openedAt > b.openedAt || (a.openedAt === b.openedAt && (a.windowId ?? 0) > (b.windowId ?? 0));
  /** Each panel's arbitration: its other messages wait for it, and do nothing if it lost (it is closing). */
  const panelAllowed = new Map<Browser.runtime.Port, Promise<boolean>>();
  const closedPanels = new WeakSet<Browser.runtime.Port>();
  /**
   * Which window's panel each losing panel lost to, and when: a choice moving the panel to that very window, sent
   * just before, is the handoff that opened it (its message and the new panel's hello come over different ports, in
   * either order) — not a loser's late, unrelated move (another window, or long after).
   */
  const lostTo = new WeakMap<Browser.runtime.Port, { windowId: number | undefined; at: number }>();
  const LOST_TO_MS = 3_000;
  /**
   * Tab choices from the panels, and bringing a moved tab forward, one at a time in arrival order (decision 95): a
   * later one always acts after an earlier one is done, so none can land over a newer one.
   */
  let tabTurn: Promise<void> = Promise.resolve();
  const inTabTurn = (step: () => Promise<void>) => void (tabTurn = tabTurn.then(step).catch(() => {}));
  /**
   * Whether a panel of `windowId` has the side panel now: the latest opened, and one of its panels is connected and
   * won (not told to close) — the latest opened alone stays so after it closed.
   */
  async function panelLiveIn(windowId: number) {
    if ((await latestPanel())?.windowId !== windowId) return false;
    for (const [port, p] of panelWindows) {
      // Still connected after waiting for its arbitration (it may have closed meanwhile).
      if (p.windowId === windowId && (await (panelAllowed.get(port) ?? false)) && panelWindows.has(port)) return true;
    }
    return false;
  }
  /** A choice that moved the panel to its tab's window: its tab brought forward once the panel there won. */
  let pendingMove: { tabId: number; windowId: number } | null = null;
  /** In the turn: the moved tab activated, and its window focused if the panel there still has the side panel. */
  async function bringMoved(windowId: number) {
    const move = pendingMove;
    if (!move || move.windowId !== windowId) return;
    pendingMove = null;
    // Only while a panel there has the side panel (another window's may have won meanwhile, or it closed) and the tab
    // is still in that window (not dragged to another): before and after activating.
    const stillThere = async () =>
      (await panelLiveIn(move.windowId)) && (await browser.tabs.get(move.tabId).catch(() => null))?.windowId === move.windowId;
    if (!(await stillThere())) return;
    const [before] = await browser.tabs.query({ active: true, windowId: move.windowId }).catch(() => []);
    const t = await browser.tabs.update(move.tabId, { active: true }).catch(() => undefined);
    // Lost while activating: that window's tab as it was.
    if (t && !(await stillThere())) {
      if (before?.id !== undefined && before.id !== move.tabId) await browser.tabs.update(before.id, { active: true }).catch(() => {});
      return;
    }
    if (t) {
      await browser.windows.update(move.windowId, { focused: true }).catch(() => {});
    }
  }
  /**
   * Replaced by another device (decision 89): not following a room here any more (the saved room stays, for "여기서
   * 계속") — what is watched is the active tab again (decision 95).
   */
  function outOfRoomMode() {
    roomKnown = true;
    platform?.tabs?.setRoom?.({ inRoom: false, site: null });
  }
  /** A room was opened or closed in this worker (before that, the saved room says whether it is in one). */
  let roomKnown = false;
  /**
   * Following the active tab, a video tab of another window became active while the panel is in another window: a
   * toast over it offers to move the panel there (Chrome opens a side panel only on the user's own click). Each tab's
   * latest offer counts (a click on an older one in that tab does nothing), kept with when it runs out: shown again,
   * for the time left, when its page redraws (TOAST_READY), until answered.
   */
  const panelOffers = new Map<number, { toast: Omit<ToastMessage, 'seq' | 'ms'>; until: number }>();
  browser.tabs.onRemoved.addListener((id) => void panelOffers.delete(id));
  const onYouTube = (url?: string) => !!url && url.startsWith(new URL(SITE_HOME.youtube).origin + '/');
  function offerPanelHere(tabId: number, windowId: number) {
    if (![...panelWindows.values()].some((p) => p.windowId !== windowId)) return; // no panel elsewhere
    const toast = {
      type: TOAST, kind: 'panel', target: String(windowId), panelOpen: false, alertId: ++alertIds, total: PANEL_OFFER_MS,
      title: '이 창에서 보시나요?', body: 'Mirattic 패널을 이 창으로 옮기면 이 탭의 영상을 인식합니다.',
    } as const;
    panelOffers.set(tabId, { toast, until: Date.now() + PANEL_OFFER_MS });
    sendOffer(tabId, toast.alertId);
  }
  /** The tab's offer `alertId` sent (first, or again to a redrawn page) for the time it has left, if it still applies. */
  function sendOffer(tabId: number, alertId: number) {
    // In line with every other message to the pages (a clear sent before it can't arrive after it). A YouTube tab
    // opened before the extension was installed or updated has no script yet: put one in, then offer.
    sending = sending
      .then(async () => {
        // The message, numbered (the pages' order; a toast without one is dropped) — or null, once it no longer
        // applies: no longer the tab's latest offer or run out, the tab no longer active and on YouTube (it may have
        // moved on while this waited), signed out, the active tab no longer followed, no panel in another window.
        const current = async () => {
          const o = panelOffers.get(tabId);
          const t = await browser.tabs.get(tabId).catch(() => null);
          const now = Date.now();
          if (o?.toast.alertId !== alertId || o.until <= now || !t?.active || !onYouTube(t.url)) return null;
          const elsewhere = [...panelWindows.values()].some((p) => p.windowId !== t.windowId);
          if (!meId || !(platform?.followsActive() ?? !room) || !elsewhere) return null;
          return { ...o.toast, ms: o.until - now, seq: ++seq };
        };
        let offer = await current();
        if (!offer) return;
        if (await browser.tabs.sendMessage(tabId, offer).then(() => true, () => false)) return;
        if (!(await current())) return;
        const injected = await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/youtube.js'] }).catch(() => null);
        if (injected && (offer = await current())) await browser.tabs.sendMessage(tabId, offer).catch(() => {});
      })
      .catch(() => {});
  }
  /** The room's site for the tabs taken over by themselves, kept for a worker restart (decision 94). */
  let roomSite: MediaProvider | null | undefined;
  /** Which room `roomSite` is of: another room opened starts with its site unknown until it loads. */
  let roomSiteOf: string | null = null;
  function setRoomSite(site: MediaProvider | null, of: string | null) {
    platform?.tabs?.setRoom?.({ inRoom: room !== null, site });
    if (site === roomSite && of === roomSiteOf) return;
    roomSiteOf = of;
    roomSite = site;
    // With its room: a restart restores it only for that same room.
    void browser.storage.session.set({ [roomSiteEntry]: { roomId: of, site } }).catch(() => {});
  }
  /** Panels showing a room, and which one. */
  const viewers = new Map<Browser.runtime.Port, string>();
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let platform: Watch | null = null;
  let watching: Promise<Watch> | null = null;
  let socket: Socket | null = null;
  let status: SocketStatus = 'closed';
  let meId: string | null = null;
  let room: RoomSync | null = null;
  /**
   * Rooms of mine their host closed (decision 90), each with the account it was told to (only that account's are
   * shown: another may sign in meanwhile) and whether a panel showed it — kept after that, so the same notice sent
   * again (the server repeats it until our ack reaches it) isn't shown twice.
   */
  let closedRooms: (Shared['closedRooms'][number] & { userId: string; seen?: boolean })[] = [];
  /** The host changed my rooms' types (decision 93): one per room, shown (panel or toast) until answered. */
  let typeNotices: Shared['typeNotices'] = [];
  const dropTypeNotice = (roomId: string) => {
    typeNotices = typeNotices.filter((n) => n.roomId !== roomId);
    dropAlerts((a) => a.kind === 'type' && a.target === roomId);
  };
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  /** Bumped by every sign-out: a sign-in still finishing after one must not start anything. */
  let session = 0;

  const post = (port: Browser.runtime.Port, message: ToPanel) => {
    try {
      port.postMessage(message);
    } catch {
      // the panel just closed
    }
  };
  const broadcast = (message: ToPanel) => ports.forEach((p) => post(p, message));
  const shared = (): Shared => ({
    watching: platform?.nowWatching?.() ?? null,
    watchingInfo: platform?.nowWatchingInfo?.() ?? null,
    offSite: platform?.offSite?.() ?? null,
    askOnSwitch: platform?.preferences?.askOnSwitch() ?? true,
    tabs: platform?.tabs?.list() ?? [],
    followedTab: platform?.tabs?.followed() ?? null,
    followActive: platform?.tabs?.auto() ?? false,
    experiments: {
      netflix: platform?.experimental?.enabled('netflix') ?? false,
      laftel: platform?.experimental?.enabled('laftel') ?? false,
    },
    activeRoom: room && !room.state.closed ? room.state.roomId : null,
    alertsUntil: Object.fromEntries([...alertUntil].filter(([, until]) => until > Date.now())),
    closedRooms: closedRooms.filter((c) => c.userId === meId && !c.seen).map(({ roomId, title, userId }) => ({ roomId, title, userId })),
    typeNotices,
  });
  const pushShared = () => broadcast({ kind: 'shared', shared: shared() });

  /**
   * An invite, a join request, a pause request, or the friend I asked letting me in (plan.md decision 87), while
   * no panel is open (an open one shows them itself): drawn over the video in the provider tabs (toast.ts, answered
   * there: `answerAlert`; a page loaded meanwhile gets the ones still counting) and counted on the toolbar icon.
   * A panel opening clears them all. Chat never alerts here. `alerts`: the ones still counting, newest first.
   */
  let alerts: Alert[] = [];
  let alertIds = Date.now() * 1000; // rising across worker restarts too: a page never mistakes a new alert for an old one
  let publishing = Promise.resolve();
  /**
   * When each alert runs out, kept past the panel opening (which clears the alerts): the panel counts the same
   * time down, even from a server that doesn't send the time left.
   */
  const alertUntil = new Map<string, number>();
  /** Invitations waiting for their channel lookup, by room: only the latest lookup shows, if not settled meanwhile. */
  const pendingInvites = new Map<string, object>();

  /** `ms`: how long it counts (decision 87: 30 s): the toast shows that long, the badge counts it that long. */
  function alert(kind: AlertKind, target: string, ms: number, title: string, body = '', meta?: string) {
    if (!meId || ports.size) return; // signed out: nothing; a panel open: it shows it (recordEnd ran)
    const toast = { type: TOAST, kind, target, ms, title, meta, body, panelOpen: false, alertId: ++alertIds } as const;
    const entry: Alert = { kind, target, title, toast, until: Date.now() + ms };
    for (const [key, until] of alertUntil) if (until <= Date.now()) alertUntil.delete(key);
    alertUntil.set(`${kind}:${target}`, entry.until);
    alerts = [entry, ...alerts.filter((a) => a.kind !== kind || a.target !== target)];
    toastOverVideo(toast, entry);
    publishAlerts();
    setTimeout(() => dropAlerts((a) => a === entry), ms);
  }

  /**
   * A new invitation or watch request counts from now (the server's time left): its end is saved as it arrives —
   * before the panel hears of it, before any lookup — replacing an earlier one's.
   */
  function recordEnd(event: ServerEvent) {
    const payload = event.payload as (RoomView | IncomingRequest) & { expiresInMs?: number };
    const key = event.type === 'room:invite' ? `invite:${payload.id}` : event.type === 'watch:request' ? `request:${payload.id}` : null;
    if (!key) return;
    alertUntil.set(key, Date.now() + (payload.expiresInMs ?? INCOMING_MS));
    if (ports.size) pushShared();
  }

  /**
   * "YouTube · channel": the channel from the host's presence, when they share it and watch that video. The lookup
   * gets `LOOKUP_MS`: past it, just the site (the alert can't wait out its 30 s).
   */
  /** The lookup's answer, or `fallback` once `LOOKUP_MS` has passed (an alert can't wait out its 30 s). */
  const within = <T,>(lookup: Promise<T>, fallback: T) =>
    Promise.race([lookup, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), LOOKUP_MS))]);

  /** The alert's line about the room's video; undefined for a room without one yet (decision 92). */
  async function whereToWatch(content: RoomContent | null, hostId: string) {
    if (!content) return undefined;
    let channel: string | undefined;
    if (content.provider === 'youtube') {
      const friends = await within(api.friends().catch(() => []), []);
      const media = friends.find((f) => f.user.id === hostId)?.presence.media;
      if (media?.provider === 'youtube' && media.contentId === content.contentId) channel = media.channel;
    }
    return channel ? `${PROVIDER_NAMES[content.provider]} · ${channel}` : PROVIDER_NAMES[content.provider];
  }

  /**
   * The friend I asked let me in (`watch:answer`) with no panel open: into the room here (the sync runs without
   * one; the video opens as on entering), and an alert whose button opens the panel — Chrome opens it only on a
   * click.
   */
  async function enterAnswered(roomId: string, friendId: string | undefined) {
    openRoom(roomId, true);
    const until = Date.now() + INCOMING_MS; // from now, however long the details take (each lookup bounded)
    const view = await within(api.room(roomId).catch(() => null), null);
    const host = view?.members.find((m) => m.role === 'HOST')?.user;
    const meta = view ? await whereToWatch(view.content, host?.id ?? friendId ?? '') : undefined;
    const ms = until - Date.now();
    if (ms > 0) alert('answered', roomId, ms, `${host?.displayName ?? '친구'}님이 합류 요청을 수락했습니다`, view?.content?.title ?? '', meta);
  }

  /** Settled (answered, cancelled, expired): no longer counted, and off every page, so it can't be answered. */
  function dropAlerts(gone: (a: Alert) => boolean) {
    const settled = alerts.filter(gone);
    if (!settled.length) return;
    alerts = alerts.filter((a) => !gone(a));
    publishAlerts();
    for (const { kind, target } of settled) toTabs({ type: TOAST_DISMISS, kind, target });
  }

  /** Still counting, and (if named) the same alert — not an earlier one for the same friend or room. */
  const active = (kind: AlertKind, target: string, alertId?: number) =>
    alerts.some((a) => a.kind === kind && a.target === target && a.until > Date.now()
      && (alertId === undefined || a.toast.alertId === alertId));

  /**
   * Badge and tooltip follow `alerts` as it is when each step runs, one step at a time: a clear queued after an
   * alert always wins, and alerts arriving together all count.
   */
  function publishAlerts() {
    publishing = publishing
      .then(async () => {
        const list = alerts;
        await browser.action.setBadgeBackgroundColor({ color: '#3f6b5a' });
        await browser.action.setBadgeText({ text: list.length ? String(list.length) : '' });
        await browser.action.setTitle({ title: list[0]?.title ?? 'Mirattic Sync' });
      })
      .catch(() => {});
  }

  /**
   * To the provider tabs (only those with our script answer; toast.ts): a visible video draws it. Sent only if
   * its alert still counts by then (a clear or dismissal queued before it wins).
   */
  const toastOverVideo = (message: Omit<ToastMessage, 'seq'>, entry: Alert) =>
    toTabs(message, () => alerts.includes(entry));

  /**
   * One at a time, in order, each delivered before the next; and numbered (`seq`, rising across worker restarts
   * too), so a page drops a toast that still arrives after the clear or dismissal sent later. `tabId`: one tab
   * only (a page asking for the alerts still counting).
   */
  let sending = Promise.resolve();
  let seq = Date.now() * 1000;
  type Outgoing = Omit<ToastMessage, 'seq'> | Omit<ToastDismiss, 'seq'> | Omit<ToastClear, 'seq'>;
  function toTabs(message: Outgoing, still = () => true, tabId?: number) {
    const numbered = { ...message, seq: ++seq };
    sending = sending
      .then(async () => {
        const ids = tabId !== undefined ? [tabId]
          : (await browser.tabs.query({ url: PROVIDER_TABS }).catch(() => [])).map((t) => t.id);
        if (!still()) return;
        await Promise.all(ids.map((id) => id !== undefined && browser.tabs.sendMessage(id, numbered).catch(() => {})));
      })
      .catch(() => {});
  }

  /**
   * The alert's buttons over the video, doing what the panel's would. Entering a room needs no panel (the sync
   * runs here); the panel opens too if Chrome still counts the click, and follows the room. Failures (the invite
   * gone, nothing watched) leave it to the panel.
   */
  async function answerAlert({ kind, target, accept, always }: ToastAnswer) {
    const answered = alerts.find((a) => a.kind === kind && a.target === target);
    if (!answered || !meId) return;
    // Off the list now (a second click does nothing); back if the call fails, unless it is gone for good.
    dropAlerts((a) => a === answered);
    try {
      if (kind === 'invite') {
        if (!accept) await api.declineInvitation(target);
        else {
          await api.acceptInvitation(target);
          openRoom(target, true);
        }
      } else if (kind === 'request') {
        if (!accept) await api.dismissWatchRequest(target);
        else openRoom(await watchTogether(target), true);
        // Answered: an open panel's banner goes, as when the friend takes it back.
        broadcast({ kind: 'event', event: { type: 'watch:cancel', userId: target, serverTime: Date.now(), payload: null } });
      } else if (kind === 'type') {
        // The toast is the room's latest change (a newer one replaces it): its version is the notice's.
        await answerType(target, typeNotices.find((n) => n.roomId === target)?.version ?? 0, !accept, always === true);
      } else if (kind === 'pause' && room?.state.roomId === target && room.state.pauseRequest) {
        if (accept) room.pauseAll();
        else room.dismissPauseRequest();
      }
    } catch (e) {
      // Still open (nothing watched, offline): answerable again for its time left. Gone (404): nothing to redo.
      const left = answered.until - Date.now();
      if (!(e instanceof ApiError && e.status === 404) && left > 0) alert(kind, target, left, answered.title, answered.toast.body, answered.toast.meta);
    }
  }

  /**
   * The rooms whose type changed since I saw it (decision 93): from my rooms as the server has them (`typeVersion`
   * above my `typeSeen`, not hosted by me) — so nothing is lost while offline or across a worker restart, and a room
   * I'm out of (left, kicked, closed) asks nothing. New ones (or newer versions) alert while no panel is open.
   */
  let typeChecks = 0;
  /** The latest check applied: an earlier one answering later is older news; a newer one failing doesn't void it. */
  let typeApplied = 0;
  /**
   * Rooms where "이 방에서는 항상 허용하기" was checked: their type changes are confirmed (and followed) without asking —
   * unless the new site's control (experimental) is off. In storage.local, the latest 50.
   */
  // Per account (another one signing in here didn't choose it).
  const typeAlwaysOf = new Map<string, Promise<Set<string>>>();
  const typeAlways = (userId: string) => {
    let got = typeAlwaysOf.get(userId);
    if (!got) {
      const key = `${TYPE_ALWAYS_ITEM}.${userId}`;
      got = browser.storage.local.get(key).then(
        (v) => new Set<string>(Array.isArray(v[key]) ? v[key].filter((id: unknown) => typeof id === 'string') : []),
        () => new Set<string>());
      typeAlwaysOf.set(userId, got);
    }
    return got;
  };
  const confirming = new Set<string>(); // automatic confirmations under way (one per room)
  const typeFailedAt = new Map<string, number>(); // a confirmation's failure, per room: not automatic again for a while
  async function checkTypes() {
    const mine = ++typeChecks;
    const me = meId;
    if (!me) return;
    const [list, always] = await Promise.all([api.rooms().catch(() => null), typeAlways(me)]);
    if (me !== meId || mine <= typeApplied) return;
    if (!list) {
      if (mine === typeChecks) setTimeout(() => mine === typeChecks && void checkTypes(), 2_000); // the latest failed: again
      return;
    }
    typeApplied = mine;
    const pending = list.flatMap((r) => r.type && (r.typeVersion ?? 0) > (r.typeSeen ?? 0)
      && !r.members.some((m) => m.user.id === me && m.role === 'HOST')
      ? [{ roomId: r.id, type: r.type, version: r.typeVersion ?? 0 }] : []);
    const off = (t: MediaProvider) => (t === 'netflix' || t === 'laftel') && !platform?.experimental?.enabled(t);
    // Not one whose automatic confirmation failed a moment ago: asked (shown) instead, tried again after a while.
    const auto = pending.filter((n) => always.has(n.roomId) && !off(n.type)
      && Date.now() - (typeFailedAt.get(n.roomId) ?? 0) >= TYPE_RETRY_MS);
    for (const n of auto) {
      if (confirming.has(n.roomId)) continue;
      confirming.add(n.roomId);
      void answerType(n.roomId, n.version, false).catch(() => {}).finally(() => confirming.delete(n.roomId));
    }
    const next = pending.filter((n) => !auto.includes(n));
    for (const old of typeNotices) {
      if (!next.some((n) => n.roomId === old.roomId)) dropAlerts((a) => a.kind === 'type' && a.target === old.roomId);
    }
    for (const n of next) {
      if (!typeNotices.some((o) => o.roomId === n.roomId && o.version >= n.version)) toastType(n); // new or newer
    }
    typeNotices = next;
    pushShared();
  }
  /** Over the videos while no panel is open (a panel open asks itself; closed unanswered, it toasts again). */
  function toastType(n: Shared['typeNotices'][number]) {
    const off = (n.type === 'netflix' || n.type === 'laftel') && !platform?.experimental?.enabled(n.type);
    alert('type', n.roomId, INCOMING_MS, `방장이 방을 ${PROVIDER_NAMES[n.type]} 방으로 바꿨습니다`,
      off ? `${PROVIDER_NAMES[n.type]} 제어(실험)가 꺼져 있습니다. 패널에서 켜거나 방을 나가세요.` : '');
  }
  async function keepTypeAlways(userId: string, roomId: string) {
    const set = await typeAlways(userId);
    set.delete(roomId);
    set.add(roomId); // the latest last
    const kept = [...set].slice(-50);
    for (const id of set) if (!kept.includes(id)) set.delete(id); // the oldest ones out here too
    await browser.storage.local.set({ [`${TYPE_ALWAYS_ITEM}.${userId}`]: kept }).catch(() => {});
  }
  /** Many room updates in a moment (a hand-over, members coming and going): one look. */
  let typeCheckTimer: ReturnType<typeof setTimeout> | undefined;
  function checkTypesSoon() {
    clearTimeout(typeCheckTimer);
    typeCheckTimer = setTimeout(() => void checkTypes(), 500);
  }

  /**
   * The room's type change answered (decision 93): confirmed up to `version`, or the room left — as a member only:
   * handed the host meanwhile, the server refuses (409) instead of closing the room. Then looked at again (a failure
   * leaves it to answer again).
   */
  async function answerType(roomId: string, version: number, leave: boolean, always = false) {
    // The account answering, for all that follows (one signing in meanwhile gets nothing of it).
    const me = meId;
    const mine = session;
    const still = () => me !== null && meId === me && session === mine;
    let failed = false;
    try {
      if (!leave) {
        await api.seeRoomType(roomId, version);
        // Confirmed: the notice goes, and the room here is told (it reloads: the server tells no one of a confirmation)
        // — its sync moves the tab to the room's site once the room says so, and resumes. Another room: when entered.
        if (room?.state.roomId === roomId && still()) room.confirmType(version);
        void checkTypes();
        if (always && still()) await keepTypeAlways(me!, roomId);
      } else {
        const left = await api.leaveRoom(roomId, true).then(() => true, (e) => {
          if (e instanceof ApiError && e.status === 404) return true; // gone already: left
          if (e instanceof ApiError && e.status === 409) return false; // the host now: stays
          throw e;
        });
        if (left && room?.state.roomId === roomId) closeRoom();
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      // Looked at again now: after a failure, the room is asked (shown) instead of confirmed automatically for a while,
      // and looked at again after that (not a tight loop of retries).
      if (failed) {
        typeFailedAt.set(roomId, Date.now());
        setTimeout(() => void checkTypes(), TYPE_RETRY_MS);
      }
      void checkTypes();
    }
  }

  /** As the panel's "같이 보기": into my room for what I watch now, or a new room with it (or without a video yet). */
  async function watchTogether(friendId: string) {
    const watching = platform?.nowWatching?.() ?? null;
    const hosted = roomToInvite(await api.rooms(), meId!, room?.state.roomId ?? null, watching);
    if (hosted) {
      await api.inviteToRoom(hosted.id, [friendId]);
      return hosted.id;
    }
    return (await api.createRoom(watching, [friendId])).id; // decision 92: no video yet is fine
  }

  /** All of them, and every toast on the pages (a panel opened, signed out, a restarted worker's leftovers). */
  function clearAlerts() {
    alerts = [];
    pendingInvites.clear();
    publishAlerts();
    toTabs({ type: TOAST_CLEAR });
  }
  clearAlerts();

  /** Tabs are looked at only after the user's consent (Chrome Web Store user data policy). */
  /** `follow`: also follow `windowId` if the watcher exists already (a panel's hello decides that itself). */
  async function ensureWatching(windowId?: number, follow = true) {
    if (!(await hasConsent())) return null;
    // The room's site as kept (decision 94): a restarted worker picks no other site's tab before its room is back.
    // In a room (kept for a restart too): the chosen tab is followed; out of one, the active tab (decision 95).
    watching ??= browser.storage.session.get([roomSiteEntry, ROOM_KEY])
      // Its site: kept (a site, or null for a room without one), else unknown (undefined: nothing taken until known).
      .then((v) => {
        const savedRoom = typeof v[ROOM_KEY] === 'string' ? (v[ROOM_KEY] as string) : null;
        const kept = v[roomSiteEntry] as { roomId?: unknown; site?: unknown } | undefined;
        // The kept site only if it is that room's (a site, or null for a room without one); else unknown.
        const site = savedRoom && kept?.roomId === savedRoom && (typeof kept.site === 'string' || kept.site === null)
          ? (kept.site as MediaProvider | null) : undefined;
        return { site, inRoom: savedRoom !== null, savedRoom };
      }, () => ({ site: undefined, inRoom: false, savedRoom: null }))
      .then(({ site, inRoom, savedRoom }) => {
        if (inRoom && roomSite === undefined) {
          roomSite = site; // the room's site as kept, until its room says
          roomSiteOf = savedRoom;
        }
        return watch({ windowId, site, inRoom, onOtherWindow: offerPanelHere });
      })
      .then((p) => {
      platform = p;
      p.subscribe?.(() => {
        pushShared();
        room?.refreshPlayer();
        room?.watchingChanged();
      });
      if (status === 'open') p.connected?.(socket);
      // A room entered or left while it was being created: as things are now — once known (a restarted worker keeps
      // its saved room's mode until that room is reopened or closed).
      if (roomKnown) {
        p.tabs?.setRoom?.({ inRoom: room !== null, site: room && roomSiteOf === room.state.roomId ? roomSite : room ? undefined : null });
      }
      return p;
    });
    const p = await watching;
    if (windowId !== undefined && follow) p.follow(windowId);
    return p;
  }

  function startSocket() {
    if (socket) return;
    const mine = session; // (not `s`: the first status comes before connectSocket returns)
    const s = connectSocket({
      url: SOCKET_URL,
      getTicket: api.wsTicket,
      onStatus: (next) => {
        if (mine !== session) return; // a socket from before a sign-out: its news are stale
        status = next;
        platform?.connected?.(next === 'open' ? s : null);
        room?.setConnected(next === 'open');
        if (next === 'replaced') {
          // Another device took over (decision 89): this one stops following the room (still a member; the
          // other device can go on in it) and alerts, until "여기서 계속" (resume) takes it back.
          markReplaced(true);
          room?.dispose();
          room = null;
          outOfRoomMode();
          clearAlerts();
          pushShared();
        }
        if (next === 'open') void backIntoRoom(); // after a resume: the room it was in, if it still is
        if (next === 'open') void checkTypes(); // type changes while away (decision 93)
        broadcast({ kind: 'status', status: next });
        if (next === 'closed' && socket === s) signOut(); // the session is gone (the ticket answered 401)
      },
      onEvent: (event) => {
        room?.handle(event);
        recordEnd(event); // before the panel hears of it (it reloads on it)
        broadcast({ kind: 'event', event });
        // Only from this session's socket (not one from before a sign-out): kept for this account, acknowledged on
        // the socket it came by (a repeat is dropped there; not stored: the server sends it again later).
        if (event.type === 'room:closed' && event.roomId && meId && mine === session) {
          const title = (event.payload as { title?: string } | null)?.title ?? '';
          const roomId = event.roomId;
          void setClosedRooms([...closedRooms, { roomId, title, userId: meId }])
            .then(() => mine === session && s.send({ type: 'room:closed:ack', roomId, payload: null }), () => {});
        }
        alertFor(event);
        if (event.type === 'chat:message' && event.roomId === room?.state.roomId) markRead(500);
      },
    });
    socket = s;
    keepAlive = setInterval(() => socket?.send({ type: 'sync:request', reqId: 'keepalive', payload: null }), KEEPALIVE_MS);
  }

  function alertFor(event: ServerEvent) {
    // A room's type changed (decision 93), or a room of mine changed (hand-over, kicked, closed): looked at again.
    if (event.type === 'room:type') void checkTypes();
    else if (event.type === 'room:update') checkTypesSoon();
    if (event.type === 'room:invite') {
      const view = event.payload as RoomView;
      const host = view.members.find((m) => m.role === 'HOST');
      // Counted from now (the server's time left), not from when the channel lookup ends; not shown if it was
      // settled meanwhile (`pendingInvites`).
      const until = Date.now() + (view.expiresInMs ?? INCOMING_MS);
      const title = `${host?.user.displayName ?? '친구'}님의 같이 보기 초대`;
      const lookup = {};
      pendingInvites.set(view.id, lookup);
      void whereToWatch(view.content, host?.user.id ?? '').then((meta) => {
        if (pendingInvites.get(view.id) !== lookup) return; // settled, or invited again since
        pendingInvites.delete(view.id);
        const ms = until - Date.now();
        if (ms > 0) alert('invite', view.id, ms, title, view.content?.title ?? '아직 고른 영상이 없습니다', meta);
      });
    }
    // Answered by me elsewhere (`room:update` to me), or the room closed: the invitation is settled.
    if (event.type === 'room:update' && event.roomId) {
      pendingInvites.delete(event.roomId);
      dropAlerts((a) => a.kind === 'invite' && a.target === event.roomId);
    }
    // The friend I asked let me in: the panel does it when open (it asked), else it happens here.
    if (event.type === 'watch:answer' && event.roomId && !ports.size) void enterAnswered(event.roomId, event.userId);
    if (event.type === 'watch:request') {
      const from = event.payload as IncomingRequest;
      alert('request', from.id, from.expiresInMs ?? INCOMING_MS, `${from.displayName}님이 같이 보자고 합니다`);
    }
    if (event.type === 'watch:cancel') dropAlerts((a) => a.kind === 'request' && a.target === event.userId);
    const asked = room?.state.pauseRequest;
    if (event.type === 'pause:request' && asked && asked.userId === event.userId) {
      alert('pause', room!.state.roomId, PAUSE_REQUEST_SHOWN_MS, `${asked.name}님이 일시정지를 요청했습니다`, asked.reason);
    }
  }

  const viewing = () => !!room && [...viewers.values()].includes(room.state.roomId);

  /**
   * The server marks a room read on join and leave; the extension stays joined with the panel closed, so it
   * marks what the user saw while a panel shows the room (on opening it, as messages arrive, on leaving it).
   */
  function markRead(delayMs = 0) {
    clearTimeout(readTimer);
    const send = () => {
      if (room && viewing()) socket?.send({ type: 'room:read', roomId: room.state.roomId, payload: {} });
    };
    // Without a delay (opening, leaving the screen, the panel closing): now, while the panel still counts as
    // viewing — this also covers a delayed one still pending.
    if (delayMs === 0) send();
    else readTimer = setTimeout(send, delayMs);
  }

  /** `entering`: the user opened it now, not the worker restoring it after a restart. */
  function openRoom(roomId: string, entering = false) {
    // Replaced: no room here until the user takes over (the room it was in comes back then).
    if (!meId || replaced() || status === 'replaced' || room?.state.roomId === roomId) return;
    room?.dispose();
    const sync: RoomSync = new RoomSync({
      roomId,
      meId,
      loadRoom: (id) => api.room(id),
      isGone: (e) => e instanceof ApiError && e.status === 404,
      send: (event) => socket?.send(event) ?? false,
      adapter: (provider) => platform?.adapter?.(provider),
      nowWatching: () => platform?.nowWatching?.() ?? null,
      askOnSwitch: () => platform?.preferences?.askOnSwitch() ?? true,
      openOnEnter: entering,
      siteUrl: (provider) => (provider in SITE_HOME ? SITE_HOME[provider as keyof typeof SITE_HOME] : undefined),
      open: (url, newTab) => {
        console.info('[mirattic] following the host to', url); // who moved the tab, when a user reports it
        platform?.open(url, newTab);
      },
      onChange: (state) => {
        broadcast({ kind: 'room', state });
        // Replacements stay on the room's site — known once the room is loaded (kept as it was meanwhile), and for a
        // member only once they confirmed a type change (until then the site they agreed to holds).
        const r = state.room;
        const pending = !!r?.type && (r.typeVersion ?? 0) > (r.typeSeen ?? 0)
          && !r.members.some((m) => m.user.id === meId && m.role === 'HOST');
        if (room === sync && r && !pending) setRoomSite(r.type ?? null, sync.state.roomId);
        if (!state.pauseRequest) dropAlerts((a) => a.kind === 'pause'); // answered or expired (30 s)
        if (state.closed && room === sync) closeRoom();
      },
    });
    room = sync;
    roomKnown = true;
    // In a room: the chosen tab is followed; its site as known for this room (restored), else unknown until it loads.
    platform?.tabs?.setRoom?.({ inRoom: true, site: roomSiteOf === roomId ? roomSite : undefined });
    sync.setConnected(status === 'open');
    void browser.storage.session.set({ [ROOM_KEY]: roomId });
    pushShared();
  }

  /** Storage writes of the notices, one after another: each writes the latest state when its turn comes. */
  let closedWrites: Promise<void> = Promise.resolve();
  /**
   * One per account and room (`seen` if any copy is), the latest 20 shown ones kept. Resolves once a write
   * containing this state (or a later one) is stored.
   */
  function setClosedRooms(next: typeof closedRooms) {
    const same = (a: (typeof next)[number], b: (typeof next)[number]) => a.roomId === b.roomId && a.userId === b.userId;
    const once = next
      .filter((c, i) => next.findIndex((o) => same(o, c)) === i)
      // Seen if any copy is: a dismissal recorded before the stored copy was read back still counts.
      .map((c) => (next.some((o) => same(o, c) && o.seen) ? { ...c, seen: true } : c));
    // Shown ones are kept only against repeats (the latest 20); one not shown yet stays until it is.
    const keptSeen = new Set(once.filter((c) => c.seen).slice(-20));
    closedRooms = once.filter((c) => !c.seen || keptSeen.has(c));
    pushShared();
    const write = closedWrites.catch(() => {}).then(() => browser.storage.local.set({ [CLOSED_ROOMS_ITEM]: closedRooms }));
    closedWrites = write;
    return write;
  }

  function closeRoom() {
    const roomId = room?.state.roomId;
    if (roomId) dropTypeNotice(roomId); // out of it: nothing to answer
    room?.dispose();
    room = null;
    roomKnown = true;
    setRoomSite(null, null);
    void browser.storage.session.remove(ROOM_KEY);
    pushShared();
  }

  /**
   * Replaced (decision 89): the account replaced here — per account, so another one signing in isn't held back —
   * known here at once and kept in storage.local, written in order (a resume's removal never loses to the mark set
   * before it). Read once when the worker starts; every connect waits for that.
   */
  let replacedAccount: string | null = null;
  let marked = false; // set here since the worker started: the stored value (read later) is older
  const replacedLoaded = browser.storage.local.get(REPLACED_FLAG).then((r) => {
    const stored = r[REPLACED_FLAG];
    if (!marked && typeof stored === 'string') replacedAccount = stored;
  }, () => {});
  const replaced = () => !!meId && replacedAccount === meId;
  let marking = Promise.resolve();
  function markReplaced(on: boolean) {
    marked = true;
    replacedAccount = on ? meId : null;
    const account = replacedAccount;
    marking = marking
      .then(() => (account ? browser.storage.local.set({ [REPLACED_FLAG]: account }) : browser.storage.local.remove(REPLACED_FLAG)))
      .catch(() => {});
    return marking;
  }

  async function signedIn() {
    const mine = session;
    const me = await api.me();
    if (mine !== session) return;
    meId = me.id;
    pushShared(); // this account's closure notices, if any were kept
    await ensureWatching();
    if (mine !== session) return;
    await connect();
    await backIntoRoom(mine);
  }

  /**
   * The only way a socket starts (but a resume): not while replaced — this worker's or an earlier one's (worker or
   * browser restart), read before deciding — until the user takes over again.
   */
  async function connect() {
    await replacedLoaded;
    if (!meId) return;
    if (!replaced()) return startSocket();
    if (socket) return; // its status says so already
    status = 'replaced';
    room?.dispose(); // opened before the stored mark was read
    room = null;
    outOfRoomMode(); // (a restarted worker's watcher starts in its saved room's mode)
    pushShared();
    broadcast({ kind: 'status', status });
  }

  /** The room this browser was in (kept across a worker restart and a replacement), once connected again. */
  async function backIntoRoom(mine = session) {
    const saved = (await browser.storage.session.get(ROOM_KEY))[ROOM_KEY];
    // Checked after the read: replaced (or still offline) meanwhile, it stays out.
    if (mine === session && meId && status === 'open' && typeof saved === 'string' && !room) openRoom(saved);
  }

  function signOut() {
    session++;
    alertUntil.clear(); // another account may sign in next (shared with the panel by closeRoom below)
    typeNotices = []; // the same (and a check still running is stale)
    typeApplied = ++typeChecks;
    void setClosedRooms([]).catch(() => {}); // the same: their notices aren't the next account's
    void markReplaced(false); // the next sign-in connects
    clearAlerts();
    panelOffers.clear(); // not shown again to the next account's pages (a redraw asks for them)
    closeRoom();
    clearInterval(keepAlive);
    const s = socket;
    socket = null;
    meId = null;
    s?.close();
    platform?.connected?.(null);
    status = 'closed';
    broadcast({ kind: 'status', status });
  }

  /** The panel's API calls, run by the one client here. Sign-in and sign-out also start or stop the session. */
  async function callApi(name: string, args: unknown[]) {
    const fn = (api as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') throw new ApiError(400, `no such call: ${name}`);
    if (name === 'restore' && meId) return true; // already signed in: no second token rotation
    if (name === 'logout') signOut();
    const result = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    if ((name === 'loginWithMirattic' || (name === 'restore' && result === true)) && !meId) await signedIn();
    if (name === 'deleteAccount') signOut();
    return result;
  }

  /**
   * Join requests each tab showed over a video, by the document (page) that showed them. A tab's new page takes
   * those of its other documents as left behind — dismissed if the new page has no video (a YouTube page looks
   * itself; another site dismisses them at once). Keyed by document, so no order of tab events and messages matters.
   */
  const overVideo = new Map<number, Map<string | undefined, Map<string, number>>>();
  /**
   * A request a tab left behind, known late (the page that showed it is already gone): to the tab's page now, marked
   * so it looks for a video; no page of ours there (another site): dismissed.
   */
  const handOver = (tabId: number, doc: string | undefined, target: string, alertId: number, tries = 3) => {
    const a = alerts.find((x) => x.kind === 'request' && x.target === target && x.toast.alertId === alertId);
    if (!a || !active('request', target, alertId)) return;
    const message = { ...a.toast, ms: a.until - Date.now(), leftBehind: true, seq: ++seq };
    // Taken: that page reports it back (kept with it until decided). No page of ours to take it yet: dismissed if the
    // tab settled on another site; still loading, or one of ours starting: kept for its READY or its load's end —
    // and offered again a little later, in case that page asked just before this was kept.
    browser.tabs.sendMessage(tabId, message).catch(() => browser.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && !mayShowVideo(tab.url)) return dismissLeftBehind(new Map([[target, alertId]]));
      keep(tabId, doc, target, alertId);
      if (tries > 0) setTimeout(() => {
        const kept = overVideo.get(tabId)?.get(doc);
        if (kept?.get(target) !== alertId) return; // taken meanwhile
        kept.delete(target);
        handOver(tabId, doc, target, alertId, tries - 1);
      }, 2_000);
    }, () => {}));
  };
  const keep = (tabId: number, doc: string | undefined, target: string, alertId: number) => {
    const docs = overVideo.get(tabId) ?? new Map<string | undefined, Map<string, number>>();
    docs.set(doc, (docs.get(doc) ?? new Map()).set(target, alertId));
    overVideo.set(tabId, docs);
  };
  /** A YouTube page (our script is always there, it looks itself) or a Netflix/Laftel watch page. */
  const mayShowVideo = (url = '') => url.startsWith('https://www.youtube.com/')
    || (PROVIDER_ORIGINS.some((o) => url.startsWith(o)) && /\/(watch|player)\//.test(new URL(url).pathname));
  /** The requests shown by the tab's documents other than `current`, no longer kept under them. */
  const takeLeftBehind = (tabId: number, current: string | undefined) => {
    const left = new Map<string, number>();
    const docs = overVideo.get(tabId);
    if (!docs) return left;
    for (const [doc, requests] of docs) {
      if (doc === current) continue;
      requests.forEach((alertId, target) => left.set(target, alertId));
      docs.delete(doc);
    }
    return left;
  };
  const dismissLeftBehind = (left: Map<string, number>) => {
    for (const [target, alertId] of left) {
      if (active('request', target, alertId)) void answerAlert({ type: TOAST_ANSWER, kind: 'request', target, accept: false, alertId });
    }
  };
  /** Whether that document is still the tab's (pages ignore this message; Chrome rejects it for one that is gone). */
  const alive = (tabId: number, doc: string | undefined) => doc === undefined ? Promise.resolve(true)
    : browser.tabs.sendMessage(tabId, { type: 'mirattic:alive?' }, { documentId: doc }).then(() => true, () => false);
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    const docs = overVideo.get(tabId);
    if (info.status !== 'complete' || !docs || mayShowVideo(tab.url)) return; // only a provider page's url is known
    // Another site (or a provider page without our script): the requests of the pages the tab left are dismissed —
    // not those of a page still there (one that finished loading under its own toast).
    for (const [doc, requests] of docs) {
      void alive(tabId, doc).then((ok) => {
        if (ok || docs.get(doc) !== requests) return;
        docs.delete(doc);
        dismissLeftBehind(requests);
      });
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => overVideo.delete(tabId));
  /**
   * Recorded first (so a load ending meanwhile sees it), then checked: kept with that page if it is still there,
   * handed over if it is already gone (a late message).
   */
  const track = (tabId: number, doc: string | undefined, target: string, alertId: number, checked = alive(tabId, doc)) => {
    keep(tabId, doc, target, alertId);
    void checked.then((ok) => {
      const kept = overVideo.get(tabId)?.get(doc);
      if (ok || kept?.get(target) !== alertId) return; // still there, or taken meanwhile
      kept.delete(target);
      handOver(tabId, doc, target, alertId);
    });
  };

  browser.runtime.onMessage.addListener((m: ToastAnswer | ToastOverVideo | { type: typeof TOAST_READY }, sender) => {
    // Only our content script, in a provider page (the sending document's: the tab may have moved on since).
    const url = sender.url ?? sender.tab?.url ?? '';
    if (sender.id !== browser.runtime.id || !sender.tab || !PROVIDER_ORIGINS.some((o) => url.startsWith(o))) return;
    const tabId = sender.tab.id;
    if (tabId === undefined) return;
    const doc = sender.documentId;
    if (m?.type === TOAST_OVER_VIDEO) {
      if (typeof m.target !== 'string' || !active('request', m.target, m.alertId)) return;
      const { target, alertId } = m;
      // Kept for the tab's next page — unless the page that showed it is already gone (a late report): then handed
      // over now. Chrome says whether that document is still there (a message to it fails otherwise).
      track(tabId, doc, target, alertId);
      return;
    }
    if (m?.type === TOAST_READY) {
      // A page loaded meanwhile: the alerts still counting, for the time they have left — and the join requests this
      // tab left behind on a page with a video (another document's), marked so this page dismisses them unless it has
      // one (it reports them back, kept with it until decided). A page already gone again (a late READY): sent nothing, and
      // what it took is handed over to the tab's page now.
      const left = takeLeftBehind(tabId, doc);
      const checked = alive(tabId, doc);
      left.forEach((alertId, target) => track(tabId, doc, target, alertId, checked));
      void checked.then((ok) => {
        if (!ok) return;
        const now = Date.now();
        for (const a of [...alerts].reverse()) { // oldest first: each goes on top, the newest last
          if (a.until <= now) continue;
          const behind = a.kind === 'request' && left.get(a.target) === a.toast.alertId;
          toTabs({ ...a.toast, ms: a.until - now, leftBehind: behind }, () => alerts.includes(a), tabId);
        }
        // Its panel offer too (the page redrew — fullscreen, YouTube's in-page navigation): if it still applies.
        const offer = panelOffers.get(tabId);
        if (offer) sendOffer(tabId, offer.toast.alertId);
      });
      return;
    }
    // "패널 열기" over another window's video (decision 95): the panel moves there (the click is the gesture).
    if (m?.type === TOAST_ANSWER && m.kind === 'panel') {
      // The offer shown last, from its tab: answered either way, it isn't shown again when the page redraws.
      if (panelOffers.get(tabId)?.toast.alertId !== m.alertId) return;
      panelOffers.delete(tabId);
      // Only while it still applies: the tab still active and on YouTube, the active tab followed (out of a room, or
      // following it), a panel elsewhere.
      const offered = sender.tab.active && onYouTube(url);
      const following = platform?.followsActive() ?? !room;
      const here = sender.tab.windowId;
      const elsewhere = [...panelWindows.values()].some((p) => p.windowId !== here);
      if (m.accept && offered && following && elsewhere) void browser.sidePanel.open({ windowId: here }).catch(() => {});
      return;
    }
    if (m?.type !== TOAST_ANSWER || !active(m.kind, m.target, m.alertId)) return; // settled or replaced meanwhile
    // First, while the click may still count as the user's gesture; entering a room shows in it.
    if (m.accept && m.kind !== 'pause' && m.kind !== 'type') void browser.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    void answerAlert(m);
  });

  /**
   * A panel's tab choice, in the turn: applied only if that port still is the panel, or — a choice moving the panel to
   * its tab's window — the panel there won (its hello may come first). A move's tab is brought forward once the panel
   * there won (the old one is closing); any other choice drops a move still waiting.
   */
  async function chooseTab(port: Browser.runtime.Port, m: Extract<FromPanel, { op: 'tab' }>, asArrived: Promise<boolean>) {
    if (!(m.tabId === null || typeof m.tabId === 'number') || !(m.windowId === undefined || typeof m.windowId === 'number')) return;
    const watcher = await ensureWatching(); // a restarted worker: once it follows tabs again
    const moveTo = m.move === true && typeof m.tabId === 'number' && typeof m.windowId === 'number' ? m.windowId : undefined;
    const movedThere = async () => moveTo !== undefined && (await panelLiveIn(moveTo));
    // The move exception only for the panel's own handoff: it still had the side panel when it sent it, or it lost it
    // just now to the destination's panel (the one its click opened, whose hello came first).
    const lost = lostTo.get(port);
    const handoff = moveTo !== undefined && lost?.windowId === moveTo && Date.now() - lost.at < LOST_TO_MS;
    const owns = (!closedPanels.has(port) && (await (panelAllowed.get(port) ?? true)))
      || (((await asArrived) || handoff) && (await movedThere()));
    if (!owns) return;
    // A move: the watcher brings nothing forward itself, and doesn't follow a tab dragged out of the destination by
    // its lookup (the user picks again from the panel there) — then nothing is brought forward here either.
    await watcher?.tabs?.choose(m.tabId, m.windowId, moveTo !== undefined ? { move: true } : undefined);
    pendingMove = moveTo !== undefined && typeof m.tabId === 'number' && watcher?.tabs?.followed() === m.tabId
      ? { tabId: m.tabId, windowId: moveTo } : null;
    if (moveTo !== undefined && (await movedThere())) await bringMoved(moveTo);
  }

  browser.runtime.onConnect.addListener((port) => {
    // Only our own pages (the side panel), never a content script running in a provider's page.
    if (port.name !== UI_PORT || port.sender?.id !== browser.runtime.id || !port.sender.url?.startsWith(browser.runtime.getURL('/'))) return;
    ports.add(port);
    clearAlerts(); // the panel shows them now
    port.onMessage.addListener(async (m: FromPanel) => {
      // A tab choice: in the turn, as it arrives (see chooseTab).
      if (m.op === 'tab') {
        const asArrived = panelAllowed.get(port) ?? Promise.resolve(true); // whether it was the panel as it chose
        return inTabTurn(() => chooseTab(port, m, asArrived));
      }
      if (m.op === 'hello' && typeof m.openedAt === 'number') {
        // The side panel lives in one window, the latest opened (decision 94): by when each panel opened (not by when
        // its hello arrives, nor whether it is a reconnect), kept across worker restarts. An older one closes. One
        // hello decided at a time (each sees the one before it), so two arriving together can't both win.
        const openedAt = m.openedAt;
        panelAllowed.set(port, (panelTurn = panelTurn.then(() => arbitrate(port, openedAt, m.windowId))) as Promise<boolean>);
      }
      // Nothing from a panel that lost (closing), nor before its arbitration ends.
      if (!(await (panelAllowed.get(port) ?? true))) return;
      switch (m.op) {
        case 'hello':
          if (m.hold) break; // a panel still asking for consent: its window is all it says
          {
            // Its window followed only if this panel still has the side panel once that's ready (it may lose meanwhile).
            const watcher = await ensureWatching(m.windowId, false); // created for its window if none yet
            if (!(await (panelAllowed.get(port) ?? true))) break;
            if (m.windowId !== undefined) watcher?.follow(m.windowId);
            const here = m.windowId;
            if (here !== undefined && !m.hold) inTabTurn(() => bringMoved(here)); // the panel a choice moved here
          }
          post(port, { kind: 'shared', shared: shared() });
          post(port, { kind: 'status', status });
          if (room) post(port, { kind: 'room', state: room.state });
          break;
        case 'api':
          try {
            post(port, { kind: 'reply', id: m.id, ok: await callApi(m.name, m.args) });
          } catch (e) {
            post(port, { kind: 'reply', id: m.id, error: { status: e instanceof ApiError ? e.status : -1, message: String((e as Error)?.message ?? e) } });
          }
          break;
        case 'socket':
          await connect();
          post(port, { kind: 'status', status });
          break;
        case 'socket:resume':
          // This device takes over again (the other one is replaced in turn).
          await markReplaced(false);
          if (!meId) break;
          if (socket) socket.resume();
          else startSocket(); // replaced in an earlier worker or browser session: this one never connected
          break;
        case 'send':
          socket?.send(m.event);
          break;
        case 'room:open':
          await replacedLoaded; // replaced in an earlier worker: known before any room opens
          if (!(await (panelAllowed.get(port) ?? true))) break; // lost meanwhile (a newer panel opened)
          openRoom(m.roomId, !m.resume);
          viewers.set(port, m.roomId);
          if (room) post(port, { kind: 'room', state: room.state });
          markRead();
          break;
        case 'room:close':
          if (viewers.get(port) !== m.roomId) break;
          markRead(); // up to now it was on screen
          viewers.delete(port);
          break;
        case 'closed:seen':
          // Marked even if it isn't here yet (a restarted worker still reading its store): the read merges into it.
          // That account's notice only (a dismissal arriving after an account switch can't hide the next one's).
          void setClosedRooms([...closedRooms, { roomId: m.roomId, title: '', userId: m.userId, seen: true }])
            .then(() => post(port, { kind: 'closed:recorded', roomId: m.roomId, userId: m.userId }), () => {});
          break;
        case 'room:exit':
          if (room?.state.roomId === m.roomId) closeRoom();
          break;
        case 'room:act':
          if (room?.state.roomId === m.roomId && ROOM_ACTIONS.includes(m.name)) {
            (room[m.name] as (...a: unknown[]) => void)(...m.args);
          }
          break;
        case 'type:answer':
          if (typeof m.roomId === 'string' && typeof m.version === 'number') {
            void answerType(m.roomId, m.version, m.leave === true, m.always === true).catch(() => {});
          }
          break;
        case 'site':
          if (typeof m.site === 'string' && (m.windowId === undefined || typeof m.windowId === 'number')) {
            const watcher = await ensureWatching();
            if (await (panelAllowed.get(port) ?? true)) watcher?.tabs?.openSite(m.site, m.windowId); // still the panel
          }
          break;
        case 'open':
          console.info('[mirattic] opening from the panel', m.url);
          platform?.open(m.url, m.newTab);
          break;

      }
    });
    port.onDisconnect.addListener(() => {
      if (viewers.has(port)) markRead(); // the panel closed while showing the room
      ports.delete(port);
      viewers.delete(port);
      panelWindows.delete(port);
      panelAllowed.delete(port);
      closedPanels.add(port); // its messages still being handled count as from a panel that lost
      if (!ports.size) typeNotices.forEach(toastType); // closed without answering: asked over the videos again
    });
  });

  // A (re)started worker picks the session up again: signed in and consented → socket, presence and room.
  void (async () => {
    // Kept by an earlier worker: before any that came since (merged, not replaced) — unless signed out meanwhile.
    const mine = session;
    // A failed read: no kept notices (the session is restored all the same).
    const kept: unknown = (await browser.storage.local.get(CLOSED_ROOMS_ITEM).catch(() => ({}) as Record<string, unknown>))[CLOSED_ROOMS_ITEM];
    if (Array.isArray(kept) && mine === session) {
      void setClosedRooms([...kept.filter((c) => typeof c?.userId === 'string'), ...closedRooms]).catch(() => {});
    }
    if (!(await hasConsent())) return;
    if (await api.restore().catch(() => false)) await signedIn().catch(() => {});
  })();
});
