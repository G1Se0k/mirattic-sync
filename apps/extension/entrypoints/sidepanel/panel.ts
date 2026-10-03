import { browser, type Browser } from 'wxt/browser';
import { ApiError, type ApiClient, type Socket, type SocketStatus } from '@mirattic/client';
import { emptyRoomState, type RoomSyncState } from '@mirattic/sync-core';
import type { MediaProvider, ServerEvent } from '@mirattic/types';
import { textSizeOf, type Platform, type RoomHandle, type VideoTab } from '@mirattic/ui';
import { ASK_ON_SWITCH_KEY, experimentKey, TEXT_SIZE_ITEM, UI_PORT, type FromPanel, type RoomAction, type Shared, type ToPanel } from '../../ui-port';

const RECONNECT_MS = 500;
/** This page is the panel in its own window (opened by "창으로 분리"), not the side panel. */
const DETACHED = new URLSearchParams(location.search).has('detached');
const DETACHED_SIZE = { width: 420, height: 760 };


/**
 * The side panel's view of the background (ui-port.ts): an API client whose calls run there, its socket,
 * what it follows and the room it keeps in sync. Closing the panel only closes this view.
 */
/**
 * Before consent (decision 94): this panel takes part in which window has the side panel, and nothing else — closed
 * when another window's opens later. Released once the panel connects for real. ponytail: not redone if the worker
 * restarts meanwhile (the consent screen is short-lived).
 */
export function holdWindow(openedAt: number) {
  let released = false;
  let port: Browser.runtime.Port | null = null;
  const windowId = browser.windows.getCurrent().then((w) => w.id);
  // Connected again after a worker restart (the background forgets ports), until released.
  const connect = () => {
    if (released) return;
    const p = browser.runtime.connect({ name: UI_PORT });
    port = p;
    p.onMessage.addListener((m: ToPanel) => m.kind === 'close' && window.close());
    p.onDisconnect.addListener(() => void (port === p && setTimeout(connect, RECONNECT_MS)));
    void windowId.then((id) => {
      try {
        p.postMessage({ op: 'hello', windowId: id, openedAt, hold: true } satisfies FromPanel);
      } catch {
        // gone already: the reconnect says it
      }
    });
  };
  connect();
  return {
    release: () => {
      released = true;
      port?.disconnect();
    },
  };
}

/** `openedAt`: when the panel page started (which of two panels opened last wins the side panel, decision 94). */
export async function connectPanel(openedAt: number): Promise<{ api: ApiClient; platform: Platform }> {
  let port = browser.runtime.connect({ name: UI_PORT });
  /** False between a worker restart and the reconnect: the resume below restates what matters. */
  const send = (message: FromPanel) => {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };
  const replies = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  let nextId = 0;
  let shared: Shared = {
    watching: null, watchingInfo: null, offSite: null, askOnSwitch: true, tabs: [], followedTab: null, followActive: false, experiments: { netflix: false, laftel: false }, activeRoom: null, alertsUntil: {}, closedRooms: [], typeNotices: [],
  };
  let status: SocketStatus = 'closed';
  /**
   * Closure notices shown here (`closed:seen`, "account|room") the background hasn't confirmed storing: said again
   * after its restart.
   */
  const dismissed = new Map<string, { roomId: string; userId: string }>();
  const seen = (d: { roomId: string; userId: string }) => send({ op: 'closed:seen', ...d });
  let socketHandlers: { onEvent(event: ServerEvent): void; onStatus(status: SocketStatus): void } | null = null;
  /** The room this panel shows; `seen` once the background made it its active room. */
  let view: { roomId: string; state: RoomSyncState; listeners: Set<() => void>; seen: boolean; shown: boolean } | null = null;
  const windowId = (await browser.windows.getCurrent()).id;
  const subscribers = new Set<() => void>();
  /** A tab choice the background hasn't shown back yet: said again after a worker restart (the port may have dropped it). */
  let choosingTab: { tabId: number | null } | null = null;
  /** Tab choices made here: a failed move resent only while it is the latest. */
  let moves = 0;
  // Text size (Settings), kept in storage.local: applied before the app renders and on any panel's change. Each step
  // in Settings is one choice, saved at once. While this panel's saves are out, storage changes aren't applied (they
  // may be its own older ones, which would undo a quicker press); once all are done, storage is read again.
  // Known limit: two windows' panels changing it at the same moment — the write that lands last wins.
  let textSize = 100;
  const applyTextSize = (value: unknown) => {
    textSize = textSizeOf(value);
    document.documentElement.style.setProperty('--text-scale', String(textSize / 100));
    subscribers.forEach((s) => s());
  };
  let saving = 0;
  /** Bumped by every change (a press here or a storage event): a read applies only if none came while it was out. */
  let changes = 0;
  /** What storage holds, unless something changed while reading (that's newer) or the read failed (nothing new). */
  const readTextSize = async () => {
    const at = changes;
    const got = await browser.storage.local.get(TEXT_SIZE_ITEM).then((v) => ({ value: v[TEXT_SIZE_ITEM] }), () => null);
    if (got && at === changes && saving === 0) applyTextSize(got.value);
  };
  browser.storage.onChanged.addListener((changed, area) => {
    if (area !== 'local' || !(TEXT_SIZE_ITEM in changed)) return;
    changes++;
    if (saving === 0) applyTextSize(changed[TEXT_SIZE_ITEM].newValue);
  });
  await readTextSize(); // the listener is up first
  let ready!: () => void;
  const hello = new Promise<void>((r) => (ready = r));

  const onMessage = (m: ToPanel) => {
    switch (m.kind) {
      case 'close':
        window.close(); // opened in another window since
        return;
      case 'closed:recorded':
        dismissed.delete(`${m.userId}|${m.roomId}`);
        return;
      case 'reply': {
        const r = replies.get(m.id);
        replies.delete(m.id);
        if (!r) return;
        if (!m.error) r.resolve(m.ok);
        else if (m.error.status >= 0) r.reject(new ApiError(m.error.status, m.error.message));
        else r.reject(new Error(m.error.message)); // not an HTTP answer: offline, server down
        return;
      }
      case 'shared': {
        // Objects equal to the ones we have keep their identity: useSyncExternalStore reads them.
        const same = <T>(before: T, after: T) => (JSON.stringify(before) === JSON.stringify(after) ? before : after);
        shared = {
          ...m.shared,
          watching: same(shared.watching, m.shared.watching),
          watchingInfo: same(shared.watchingInfo, m.shared.watchingInfo),
          offSite: same(shared.offSite, m.shared.offSite),
          closedRooms: same(shared.closedRooms, m.shared.closedRooms),
          typeNotices: same(shared.typeNotices, m.shared.typeNotices),
          tabs: same(shared.tabs, m.shared.tabs),
        };
        if (choosingTab && (choosingTab.tabId === null ? shared.followActive : !shared.followActive && shared.followedTab === choosingTab.tabId)) {
          choosingTab = null;
        }
        // Another window's panel made a different room the active one: this view is over (back to the list).
        const v = view;
        if (v?.seen && shared.activeRoom !== v.roomId && !v.state.closed) {
          v.state = { ...v.state, closed: true };
          v.listeners.forEach((l) => l());
        }
        subscribers.forEach((s) => s());
        ready();
        return;
      }
      case 'status':
        status = m.status;
        socketHandlers?.onStatus(m.status);
        return;
      case 'event':
        socketHandlers?.onEvent(m.event);
        return;
      case 'room': {
        const v = view;
        if (v?.roomId !== m.state.roomId) return;
        v.seen = true;
        v.state = m.state;
        v.listeners.forEach((l) => l());
      }
    }
  };

  // The service worker may restart while the panel stays open (Chrome ends idle workers, or an update): the
  // port closes. Calls in flight fail, and a new port restates this view — window, socket, the room shown.
  const attach = () => {
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      for (const r of replies.values()) r.reject(new Error('background restarted'));
      replies.clear();
      status = 'connecting';
      socketHandlers?.onStatus('connecting');
      // The new worker restores its room a moment later: until it says so again, this view isn't "over".
      if (view) view.seen = false;
      setTimeout(() => {
        port = browser.runtime.connect({ name: UI_PORT });
        attach();
        send({ op: 'hello', windowId, openedAt, detached: DETACHED });
        if (socketHandlers) send({ op: 'socket' });
        if (view?.shown) send({ op: 'room:open', roomId: view.roomId, resume: true });
        dismissed.forEach(seen);
        if (choosingTab) {
          const { tabId } = choosingTab;
          // Detached: the tab's own window, as chosen (this popup has no tabs).
          send({ op: 'tab', tabId, windowId: DETACHED ? shared.tabs.find((t) => t.id === tabId)?.windowId : windowId });
        }
      }, RECONNECT_MS);
    });
  };
  attach();

  const api = new Proxy({} as ApiClient, {
    get: (_, name) => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        replies.set(id, { resolve, reject });
        send({ op: 'api', id, name: String(name), args });
      }),
  });

  send({ op: 'hello', windowId, openedAt, detached: DETACHED });
  await hello;
  /** Detached: the browser window focused last — "패널로 돌아가기" opens the side panel there without a followed tab's. */
  let browserWindow: number | undefined;
  if (DETACHED) {
    void browser.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => (browserWindow ??= w.id), () => {});
    browser.windows.onFocusChanged.addListener((id) => {
      if (id !== browser.windows.WINDOW_ID_NONE) browserWindow = id;
    }, { windowTypes: ['normal'] });
  }

  const actOn = (roomId: string) => (name: RoomAction, ...args: unknown[]) => send({ op: 'room:act', roomId, name, args });

  const platform: Platform = {
    nowWatching: () => shared.watching,
    nowWatchingInfo: () => shared.watchingInfo,
    offSite: () => shared.offSite,
    preferences: {
      askOnSwitch: () => shared.askOnSwitch,
      // Written to storage.local here, not sent over the port: a background restarting meanwhile can't drop it.
      setAskOnSwitch: (ask) => browser.storage.local.set({ [ASK_ON_SWITCH_KEY]: ask }),
    },
    tabs: {
      list: () => shared.tabs, // every window's video tabs
      followed: () => shared.followedTab,
      auto: () => shared.followActive,
      openSite: (site) => send({ op: 'site', site, windowId: DETACHED ? undefined : windowId }),
      choose: (tabId) => {
        const there = tabId === null ? undefined : shared.tabs.find((t) => t.id === tabId)?.windowId;
        if (DETACHED) {
          // Every window's tabs alike: followed where it is, nothing moved or brought forward.
          moves++;
          choosingTab = { tabId };
          send({ op: 'tab', tabId, windowId: there });
          return;
        }
        if (tabId !== null && there !== undefined && there !== windowId) {
          // A tab of another window: chosen for that window (the background takes it even if the panel there says
          // hello first), the panel opened there within this click (Chrome opens one only for a user's gesture; this
          // one then closes, decision 94), and the background shows the tab in front.
          choosingTab = { tabId };
          const mine = ++moves;
          // Not delivered (the worker restarting): the panel stays here; the resume sends the choice from here.
          if (!send({ op: 'tab', tabId, windowId: there, move: true })) return;
          const opened = browser.sidePanel.open({ windowId: there }).then(() => true, () => false);
          // Opened: the background brings the tab forward (this panel is closing). Not opened: the panel stays here,
          // so the choice is sent from here again if still the latest (brought forward as any other window's tab).
          void opened.then((ok) => !ok && mine === moves && send({ op: 'tab', tabId, windowId }));
          return;
        }
        moves++; // a choice here: an earlier move that failed to open isn't resent over it
        choosingTab = { tabId };
        send({ op: 'tab', tabId, windowId }); // this window's active tab, or a tab of it
      },
    },
    activeRoom: () => shared.activeRoom,
    alertUntil: (kind, target) => shared.alertsUntil[`${kind}:${target}`],
    closedRooms: () => shared.closedRooms,
    roomTypeNotice: () => shared.typeNotices[0] ?? null, // one at a time, the others after it's answered
    answerRoomType: (roomId, version, leave, always) => send({ op: 'type:answer', roomId, version, leave, always }),
    seenClosed: (roomId) => {
      // The account it was shown to (the one these notices are for), until the background confirms storing it.
      const shown = shared.closedRooms.find((c) => c.roomId === roomId);
      if (!shown) return;
      const key = `${shown.userId}|${roomId}`;
      dismissed.set(key, { roomId, userId: shown.userId });
      seen({ roomId, userId: shown.userId });
    },
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => void subscribers.delete(onChange);
    },
    connect: (handlers): Socket => {
      socketHandlers = handlers;
      send({ op: 'socket' });
      return {
        send: (event) => {
          if (status !== 'open') return false;
          send({ op: 'send', event });
          return true;
        },
        close: () => {
          if (socketHandlers === handlers) socketHandlers = null; // the background's socket stays
        },
        resume: () => send({ op: 'socket:resume' }),
      };
    },
    room: (roomId): RoomHandle => {
      const mine = { roomId, state: emptyRoomState(roomId), listeners: new Set<() => void>(), seen: false, shown: false };
      view = mine;
      const act = actOn(roomId);
      return {
        state: () => mine.state,
        subscribe: (onChange) => {
          mine.listeners.add(onChange);
          return () => void mine.listeners.delete(onChange);
        },
        show: () => {
          mine.shown = true;
          send({ op: 'room:open', roomId });
        },
        requestPause: (reason) => act('requestPause', reason),
        dismissPauseRequest: () => act('dismissPauseRequest'),
        pauseAll: () => act('pauseAll'),
        seek: (ms) => act('seek', ms),
        openSwitched: (always) => act('openSwitched', always),
        dismissSwitched: () => act('dismissSwitched'),
        setMuted: (muted) => act('setMuted', muted),
        retry: () => act('reload'),
        close: () => {
          mine.shown = false;
          send({ op: 'room:close', roomId });
        },
        exit: () => send({ op: 'room:exit', roomId }),
      };
    },
    experimental: {
      enabled: (provider) => (provider === 'netflix' || provider === 'laftel') && shared.experiments[provider],
      // Written to storage.local here (decision 81); the background applies it from storage.onChanged and
      // announces it back. Resolves once saved, so a restarting background can't lose it.
      setEnabled: async (provider, on) => {
        if (provider !== 'netflix' && provider !== 'laftel') return false;
        await browser.storage.local.set({ [experimentKey(provider)]: on });
        return true;
      },
    },
    open: (url, newTab) => send({ op: 'open', url, newTab }),
    turnOff: () => send({ op: 'off' }),
    panelWindow: {
      detached: DETACHED,
      toggle: () => {
        // Out: a popup window with this page; its hello closes this side panel (one panel, decision 94). Back: the side
        // panel opened (within this click) in the window of the tab followed, else the browser window focused last;
        // its hello closes this window.
        if (!DETACHED) {
          void browser.windows.create({ url: browser.runtime.getURL('/sidepanel.html?detached'), type: 'popup', ...DETACHED_SIZE });
          return;
        }
        const there = shared.tabs.find((t) => t.id === shared.followedTab)?.windowId ?? browserWindow;
        // Both within the click, nothing awaited before the open (the gesture), nor after it (this window closes as
        // the side panel there says hello): that window brought to the front, the side panel opened in it.
        if (there !== undefined) {
          void browser.windows.update(there, { focused: true }).catch(() => {});
          void browser.sidePanel.open({ windowId: there }).catch(() => {});
        }
      },
    },
    textSize: {
      get: () => textSize,
      set: (percent) => {
        changes++;
        applyTextSize(percent); // at once here; other panels follow storage.onChanged
        saving++;
        const save = browser.storage.local.set({ [TEXT_SIZE_ITEM]: textSize });
        void save.catch(() => {}).finally(() => {
          if (--saving === 0) void readTextSize();
        });
        return save;
      },
    },
  };
  return { api, platform };
}
