import { browser, type Browser } from 'wxt/browser';
import { ApiError, connectSocket, createApi, type ApiClient, type Socket, type SocketStatus } from '@mirattic/client';
import { RoomSync } from '@mirattic/sync-core';
import { API_URL, SOCKET_URL, authorize, store } from '../session';
import { hasConsent } from '../consent';
import { watch, type Watch } from '../watch';
import { ROOM_ACTIONS, UI_PORT, type FromPanel, type Shared, type ToPanel } from '../ui-port';

// The extension's engine (plan.md decision 69): signed-in session, socket, presence, the followed tab and the
// room's sync live here, not in the side panel, so closing the panel neither breaks the sync nor leaves the room.
// An open WebSocket that exchanges messages keeps a Chrome 116+ service worker alive: a keepalive goes out
// every 20 seconds. Only "방 나가기" (or the room closing) takes the user out of the room.

const KEEPALIVE_MS = 20_000;
const ROOM_KEY = 'mirattic.room'; // storage.session: back into the room if the worker restarts

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
        if (event.type === 'chat:message' && event.roomId === room?.state.roomId) markRead(500);
      },
    });
    socket = s;
    keepAlive = setInterval(() => socket?.send({ type: 'sync:request', reqId: 'keepalive', payload: null }), KEEPALIVE_MS);
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

  browser.runtime.onConnect.addListener((port) => {
    // Only our own pages (the side panel), never a content script running in a provider's page.
    if (port.name !== UI_PORT || port.sender?.id !== browser.runtime.id || !port.sender.url?.startsWith(browser.runtime.getURL('/'))) return;
    ports.add(port);
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
          openRoom(m.roomId, true);
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
