import { browser } from 'wxt/browser';
import { ApiError, type ApiClient, type Socket, type SocketStatus } from '@mirattic/client';
import { emptyRoomState, type RoomSyncState } from '@mirattic/sync-core';
import type { MediaProvider, ServerEvent } from '@mirattic/types';
import type { Platform, RoomHandle } from '@mirattic/ui';
import { ASK_ON_SWITCH_KEY, experimentKey, UI_PORT, type FromPanel, type RoomAction, type Shared, type ToPanel } from '../../ui-port';

const RECONNECT_MS = 500;


/**
 * The side panel's view of the background (ui-port.ts): an API client whose calls run there, its socket,
 * what it follows and the room it keeps in sync. Closing the panel only closes this view.
 */
export async function connectPanel(): Promise<{ api: ApiClient; platform: Platform }> {
  let port = browser.runtime.connect({ name: UI_PORT });
  const send = (message: FromPanel) => {
    try {
      port.postMessage(message);
    } catch {
      // between a worker restart and the reconnect: the resume below restates what matters
    }
  };
  const replies = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  let nextId = 0;
  let shared: Shared = {
    watching: null, watchingInfo: null, offSite: null, askOnSwitch: true, experiments: { netflix: false, laftel: false }, activeRoom: null,
  };
  let status: SocketStatus = 'closed';
  let socketHandlers: { onEvent(event: ServerEvent): void; onStatus(status: SocketStatus): void } | null = null;
  /** The room this panel shows; `seen` once the background made it its active room. */
  let view: { roomId: string; state: RoomSyncState; listeners: Set<() => void>; seen: boolean; shown: boolean } | null = null;
  const windowId = (await browser.windows.getCurrent()).id;
  const subscribers = new Set<() => void>();
  let ready!: () => void;
  const hello = new Promise<void>((r) => (ready = r));

  const onMessage = (m: ToPanel) => {
    switch (m.kind) {
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
        };
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
        send({ op: 'hello', windowId });
        if (socketHandlers) send({ op: 'socket' });
        if (view?.shown) send({ op: 'room:open', roomId: view.roomId, resume: true });
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

  send({ op: 'hello', windowId });
  await hello;

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
    activeRoom: () => shared.activeRoom,
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
  };
  return { api, platform };
}
