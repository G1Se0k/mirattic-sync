import type { ApiClient, Socket, SocketStatus } from "@mirattic/client";
import type { RoomSyncState } from "@mirattic/sync-core";
import type { MediaProvider, MediaProviderAdapter, RoomContent, ServerEvent } from "@mirattic/types";

/** A room's live side, seen from its screen (see `RoomSync`). */
export type RoomHandle = {
  state(): RoomSyncState;
  subscribe(onChange: () => void): () => void;
  /** Member: ask the host to pause, with an optional reason (30s cooldown). */
  requestPause(reason?: string): void;
  dismissPauseRequest(): void;
  pauseAll(): void;
  seek(positionMs: number): void;
  openSwitched(): void;
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

/** What differs between the desktop app and the extension, besides token storage. */
export type Platform = {
  /** A player this app drives for the provider. undefined = can't play it here. */
  adapter?(provider: MediaProvider): MediaProviderAdapter | undefined;
  /** What the user watches now; "같이 보기" shares it. Must return the same object until it changes. */
  nowWatching?(): RoomContent | null;
  subscribe?(onChange: () => void): () => void;
  /** The socket went up (or down: null). The extension publishes presence through it. */
  connected?(socket: Socket | null): void;
  /** The app's socket; absent = the screen opens its own. The extension shares its background's. */
  connect?(handlers: { onEvent(event: ServerEvent): void; onStatus(status: SocketStatus): void }): Socket;
  /** The room's live side; absent = run in the screen (left with it). The extension runs it in its background. */
  room?(roomId: string): RoomHandle;
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
  /** A system notification, shown only while the app isn't focused. */
  notify?(title: string, body: string): void;
};

// Each app (desktop, extension) builds its own client and platform and hands them over here before
// rendering. Live ES module bindings make the assignment visible to every importer.
export let api: ApiClient;
export let SOCKET_URL: string;
export let platform: Platform;

export function configure(client: ApiClient, socketUrl: string, p: Platform) {
  api = client;
  SOCKET_URL = socketUrl;
  platform = p;
}
