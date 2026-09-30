import { browser, type Browser } from 'wxt/browser';
import { ApiError, connectSocket, createApi, type ApiClient, type Socket, type SocketStatus } from '@mirattic/client';
import { PAUSE_REQUEST_SHOWN_MS, RoomSync } from '@mirattic/sync-core';
import {
  INCOMING_MS, PROVIDER_NAMES, roomToInvite, type IncomingRequest, type RoomContent, type RoomView, type ServerEvent,
} from '@mirattic/types';
import { API_URL, SOCKET_URL, authorize, store } from '../session';
import { hasConsent } from '../consent';
import { watch, type Watch } from '../watch';
import {
  TOAST, TOAST_ANSWER, TOAST_CLEAR, TOAST_DISMISS, TOAST_READY,
  type AlertKind, type ToastAnswer, type ToastClear, type ToastDismiss, type ToastMessage,
} from '../toast';
import { ROOM_ACTIONS, UI_PORT, type FromPanel, type Shared, type ToPanel } from '../ui-port';

// The extension's engine (plan.md decision 69): signed-in session, socket, presence, the followed tab and the
// room's sync live here, not in the side panel, so closing the panel neither breaks the sync nor leaves the room.
// An open WebSocket that exchanges messages keeps a Chrome 116+ service worker alive: a keepalive goes out
// every 20 seconds. Only "방 나가기" (or the room closing) takes the user out of the room.

const KEEPALIVE_MS = 20_000;
const LOOKUP_MS = 1_500; // a lookup for an alert's details, at most (`within`)
const ROOM_KEY = 'mirattic.room'; // storage.session: back into the room if the worker restarts
const PROVIDER_ORIGINS = ['https://www.youtube.com/', 'https://www.netflix.com/', 'https://laftel.net/'];
const PROVIDER_TABS = PROVIDER_ORIGINS.map((o) => `${o}*`);
/** `until`: when it stops counting. */
type Alert = { kind: AlertKind; target: string; title: string; toast: Omit<ToastMessage, 'seq'>; until: number };

export default defineBackground(() => {
  // Toolbar icon opens the side panel (outside the page, never over the player).
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  const api = createApi({ baseUrl: API_URL, store, authorize });
  const ports = new Set<Browser.runtime.Port>();
  /** Panels showing a room, and which one. */
  const viewers = new Map<Browser.runtime.Port, string>();
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let platform: Watch | null = null;
  let watching: Promise<Watch> | null = null;
  let socket: Socket | null = null;
  let status: SocketStatus = 'closed';
  let meId: string | null = null;
  let room: RoomSync | null = null;
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
    experiments: {
      netflix: platform?.experimental?.enabled('netflix') ?? false,
      laftel: platform?.experimental?.enabled('laftel') ?? false,
    },
    activeRoom: room && !room.state.closed ? room.state.roomId : null,
  });
  const pushShared = () => broadcast({ kind: 'shared', shared: shared() });

  /**
   * An invite, a join request, a pause request, or the friend I asked letting me in (plan.md decision 87), while
   * no panel is open (an open one shows them itself): drawn over the video in the provider tabs (toast.ts, answered
   * there: `answerAlert`; a page loaded meanwhile gets the ones still counting) and counted on the toolbar icon.
   * A panel opening clears them all. Chat never alerts here. `alerts`: the ones still counting, newest first.
   */
  let alerts: Alert[] = [];
  let publishing = Promise.resolve();
  /** Invitations waiting for their channel lookup, by room: only the latest lookup shows, if not settled meanwhile. */
  const pendingInvites = new Map<string, object>();

  /** `ms`: how long it counts (decision 87: 30 s): the toast shows that long, the badge counts it that long. */
  function alert(kind: AlertKind, target: string, ms: number, title: string, body = '', meta?: string) {
    if (!meId || ports.size) return; // signed out: nothing; a panel open: it shows it
    const toast = { type: TOAST, kind, target, ms, title, meta, body, panelOpen: false } as const;
    const entry: Alert = { kind, target, title, toast, until: Date.now() + ms };
    alerts = [entry, ...alerts.filter((a) => a.kind !== kind || a.target !== target)];
    toastOverVideo(toast, entry);
    publishAlerts();
    setTimeout(() => dropAlerts((a) => a === entry), ms);
  }

  /**
   * "YouTube · channel": the channel from the host's presence, when they share it and watch that video. The lookup
   * gets `LOOKUP_MS`: past it, just the site (the alert can't wait out its 30 s).
   */
  /** The lookup's answer, or `fallback` once `LOOKUP_MS` has passed (an alert can't wait out its 30 s). */
  const within = <T,>(lookup: Promise<T>, fallback: T) =>
    Promise.race([lookup, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), LOOKUP_MS))]);

  async function whereToWatch(content: RoomContent, hostId: string) {
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
    if (ms > 0) alert('answered', roomId, ms, `${host?.displayName ?? '친구'}님이 합류 요청을 수락했습니다`, view?.content.title ?? '', meta);
  }

  /** Settled (answered, cancelled, expired): no longer counted, and off every page, so it can't be answered. */
  function dropAlerts(gone: (a: Alert) => boolean) {
    const settled = alerts.filter(gone);
    if (!settled.length) return;
    alerts = alerts.filter((a) => !gone(a));
    publishAlerts();
    for (const { kind, target } of settled) toTabs({ type: TOAST_DISMISS, kind, target });
  }

  /** Still counting: only then do its buttons do anything. */
  const active = (kind: AlertKind, target: string) =>
    alerts.some((a) => a.kind === kind && a.target === target && a.until > Date.now());

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
  async function answerAlert({ kind, target, accept }: ToastAnswer) {
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

  /** As the panel's "같이 보기": into my room for what I watch now, or a new room with it. */
  async function watchTogether(friendId: string) {
    const watching = platform?.nowWatching?.() ?? null;
    const hosted = roomToInvite(await api.rooms(), meId!, room?.state.roomId ?? null, watching);
    if (hosted) {
      await api.inviteToRoom(hosted.id, [friendId]);
      return hosted.id;
    }
    if (!watching) throw new Error('nothing to watch together');
    return (await api.createRoom(watching, [friendId])).id;
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
  async function ensureWatching(windowId?: number) {
    if (!(await hasConsent())) return null;
    watching ??= watch({ windowId }).then((p) => {
      platform = p;
      p.subscribe?.(() => {
        pushShared();
        room?.refreshPlayer();
        room?.watchingChanged();
      });
      if (status === 'open') p.connected?.(socket);
      return p;
    });
    const p = await watching;
    if (windowId !== undefined) p.follow(windowId);
    return p;
  }

  function startSocket() {
    if (socket) return;
    const s = connectSocket({
      url: SOCKET_URL,
      getTicket: api.wsTicket,
      onStatus: (next) => {
        status = next;
        platform?.connected?.(next === 'open' ? s : null);
        room?.setConnected(next === 'open');
        broadcast({ kind: 'status', status: next });
        if (next === 'closed' && socket === s) signOut(); // the session is gone (the ticket answered 401)
      },
      onEvent: (event) => {
        room?.handle(event);
        broadcast({ kind: 'event', event });
        alertFor(event);
        if (event.type === 'chat:message' && event.roomId === room?.state.roomId) markRead(500);
      },
    });
    socket = s;
    keepAlive = setInterval(() => socket?.send({ type: 'sync:request', reqId: 'keepalive', payload: null }), KEEPALIVE_MS);
  }

  function alertFor(event: ServerEvent) {
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
        if (ms > 0) alert('invite', view.id, ms, title, view.content.title, meta);
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
    if (!meId || room?.state.roomId === roomId) return;
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
      open: (url, newTab) => {
        console.info('[mirattic] following the host to', url); // who moved the tab, when a user reports it
        platform?.open(url, newTab);
      },
      onChange: (state) => {
        broadcast({ kind: 'room', state });
        if (!state.pauseRequest) dropAlerts((a) => a.kind === 'pause'); // answered or expired (30 s)
        if (state.closed && room === sync) closeRoom();
      },
    });
    room = sync;
    sync.setConnected(status === 'open');
    void browser.storage.session.set({ [ROOM_KEY]: roomId });
    pushShared();
  }

  function closeRoom() {
    room?.dispose();
    room = null;
    void browser.storage.session.remove(ROOM_KEY);
    pushShared();
  }

  async function signedIn() {
    const mine = session;
    const me = await api.me();
    if (mine !== session) return;
    meId = me.id;
    await ensureWatching();
    if (mine !== session) return;
    startSocket();
    const saved = (await browser.storage.session.get(ROOM_KEY))[ROOM_KEY];
    if (mine === session && typeof saved === 'string' && !room) openRoom(saved);
  }

  function signOut() {
    session++;
    clearAlerts();
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

  browser.runtime.onMessage.addListener((m: ToastAnswer | { type: typeof TOAST_READY }, sender) => {
    // Only our content script, in a provider tab.
    const url = sender.tab?.url ?? sender.url ?? '';
    if (sender.id !== browser.runtime.id || !sender.tab || !PROVIDER_ORIGINS.some((o) => url.startsWith(o))) return;
    const tabId = sender.tab.id;
    if (m?.type === TOAST_READY) {
      // A page loaded meanwhile: the alerts still counting, for the time they have left.
      const now = Date.now();
      for (const a of [...alerts].reverse()) { // oldest first: each goes on top, the newest last
        if (a.until > now && tabId !== undefined) toTabs({ ...a.toast, ms: a.until - now }, () => alerts.includes(a), tabId);
      }
      return;
    }
    if (m?.type !== TOAST_ANSWER || !active(m.kind, m.target)) return; // settled meanwhile: nothing to do
    // First, while the click may still count as the user's gesture; entering a room shows in it.
    if (m.accept && m.kind !== 'pause') void browser.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    void answerAlert(m);
  });

  browser.runtime.onConnect.addListener((port) => {
    // Only our own pages (the side panel), never a content script running in a provider's page.
    if (port.name !== UI_PORT || port.sender?.id !== browser.runtime.id || !port.sender.url?.startsWith(browser.runtime.getURL('/'))) return;
    ports.add(port);
    clearAlerts(); // the panel shows them now
    port.onMessage.addListener(async (m: FromPanel) => {
      switch (m.op) {
        case 'hello':
          await ensureWatching(m.windowId);
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
          if (meId) startSocket();
          post(port, { kind: 'status', status });
          break;
        case 'send':
          socket?.send(m.event);
          break;
        case 'room:open':
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
        case 'room:exit':
          if (room?.state.roomId === m.roomId) closeRoom();
          break;
        case 'room:act':
          if (room?.state.roomId === m.roomId && ROOM_ACTIONS.includes(m.name)) {
            (room[m.name] as (...a: unknown[]) => void)(...m.args);
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
    });
  });

  // A (re)started worker picks the session up again: signed in and consented → socket, presence and room.
  void (async () => {
    if (!(await hasConsent())) return;
    if (await api.restore().catch(() => false)) await signedIn().catch(() => {});
  })();
});
