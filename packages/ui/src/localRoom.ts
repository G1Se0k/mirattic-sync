import { ApiError, type Socket } from "@mirattic/client";
import { RoomSync } from "@mirattic/sync-core";
import type { ServerEvent } from "@mirattic/types";
import { api, platform, type RoomHandle } from "./session";

/** The room's live side run by the screen itself (desktop): leaving the screen leaves the room. */
export function localRoom(
  roomId: string,
  meId: string,
  socket: Socket,
  subscribe: (listener: (event: ServerEvent) => void) => () => void,
): RoomHandle & { setConnected(open: boolean): void } {
  const listeners = new Set<() => void>();
  const sync = new RoomSync({
    roomId,
    meId,
    loadRoom: (id) => api.room(id),
    isGone: (e) => e instanceof ApiError && e.status === 404,
    send: (e) => socket.send(e),
    adapter: (p) => platform.adapter?.(p),
    nowWatching: () => platform.nowWatching?.() ?? null,
    open: (url, newTab) => platform.open(url, newTab),
    onChange: () => listeners.forEach((l) => l()),
  });
  const off = subscribe((e) => sync.handle(e));
  const stop = () => {
    off();
    sync.dispose();
  };
  return {
    state: () => sync.state,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    requestPause: (reason) => sync.requestPause(reason),
    dismissPauseRequest: () => sync.dismissPauseRequest(),
    pauseAll: () => sync.pauseAll(),
    seek: (ms) => sync.seek(ms),
    openSwitched: (always) => sync.openSwitched(always),
    dismissSwitched: () => sync.dismissSwitched(),
    setMuted: (muted) => sync.setMuted(muted),
    retry: () => void sync.reload(),
    show: () => {},
    close: stop,
    exit: stop,
    setConnected: (open) => sync.setConnected(open),
  };
}
