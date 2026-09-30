import type { ApiClient, Socket, SocketStatus } from "@mirattic/client";
import type { RoomSyncState } from "@mirattic/sync-core";
import type { MediaProvider, MediaProviderAdapter, RoomContent, ServerEvent, WatchingInfo } from "@mirattic/types";

/** A room's live side, seen from its screen (see `RoomSync`). */
export type RoomHandle = {
  state(): RoomSyncState;
  subscribe(onChange: () => void): () => void;
  /** Member: ask the host to pause, with an optional reason (30s cooldown). */
  requestPause(reason?: string): void;
  dismissPauseRequest(): void;
  pauseAll(): void;
  seek(positionMs: number): void;
  /** `always`: in this room, follow the host's next videos without asking. */
  openSwitched(always?: boolean): void;
  dismissSwitched(): void;
  setMuted(muted: boolean): void;
  retry(): void;
  /** The screen shows it (again): the extension counts it as seen (read marks). */
  show(): void;
  /** The screen went away. The extension stays in the room: its background keeps syncing. */
  close(): void;
  /** Left the room for good (membership gone): stop everything. */
  exit(): void;
};

/** What the extension provides the screens with (its side panel, backed by the background), besides the client. */
export type Platform = {
  /** A player the background drives for the provider (the followed tab). undefined = none here. */
  adapter?(provider: MediaProvider): MediaProviderAdapter | undefined;
  /** What the user watches now; "같이 보기" shares it. Must return the same object until it changes. */
  nowWatching?(): RoomContent | null;
  /** The same, in the parts my own status lines show (channel, episode); the same object until it changes. */
  nowWatchingInfo?(): WatchingInfo | null;
  /** The active tab is on a site whose experimental control is off; `visit` counts arrivals (decision 81). */
  offSite?(): { provider: MediaProvider; visit: number } | null;
  /** Settings kept by the platform (decision 81). Announced via `subscribe`. */
  preferences?: {
    /** Ask before following the host to another video (not of the same series). Off: follow without asking. */
    askOnSwitch(): boolean;
    setAskOnSwitch(ask: boolean): Promise<void>;
  };
  subscribe?(onChange: () => void): () => void;
  /** The socket went up (or down: null). The extension publishes presence through it. */
  connected?(socket: Socket | null): void;
  /** The background's socket, shared with the screens. */
  connect(handlers: { onEvent(event: ServerEvent): void; onStatus(status: SocketStatus): void }): Socket;
  /** The room's live side, run in the background (it keeps going when the panel closes). */
  room(roomId: string): RoomHandle;
  /** The room the app is still in (the extension keeps it when the panel closes). */
  activeRoom?(): string | null;
  /** Provider control the user turns on at their own risk (Netflix, Laftel). Absent = not offered in this app. */
  experimental?: {
    enabled(provider: MediaProvider): boolean;
    /** Call from a click: turning on may ask for a browser permission. Changes are announced via `subscribe`. */
    setEnabled(provider: MediaProvider, on: boolean): Promise<boolean>;
  };
  /**
   * Opens a watch page (built with `watchUrl`, never a URL from another user). `newTab`: always in a new tab
   * (the user's own click); otherwise the extension reuses the tab it follows (the room following the host).
   */
  open(url: string, newTab?: boolean): void;
};

// The extension builds its client and platform and hands them over here before rendering. Live ES module
// bindings make the assignment visible to every importer.
export let api: ApiClient;
export let platform: Platform;

export function configure(client: ApiClient, p: Platform) {
  api = client;
  platform = p;
}
