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

/** A browser tab on a video site the extension can follow (titles never leave the user's own panel). */
export type VideoTab = { id: number; title: string; provider: MediaProvider; windowId: number };

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
  /**
   * Text size in percent (100 = default, within `TEXT_SIZE`), kept by the platform and applied to the page as the
   * CSS `--text-scale`. Announced via `subscribe`.
   */
  textSize?: {
    get(): number;
    /** Shown at once and saved; rejects if it couldn't be saved. */
    set(percent: number): Promise<void>;
  };
  /**
   * The video tab the extension follows (the room's player). `auto`: the window's active video tab, as the user
   * switches; otherwise the one chosen stays until it closes. Announced via `subscribe`; `list` is the same array
   * until it changes.
   */
  tabs?: {
    list(): VideoTab[];
    followed(): number | null;
    auto(): boolean;
    /**
     * null: follow the active tab. `windowId`: the window it was chosen in (the extension's panel adds it). `move`: the
     * panel moves to the tab's window `windowId` with this choice — the tab isn't brought forward here (the extension's
     * background does, once the panel is there), and isn't followed if it has left that window by then.
     */
    choose(tabId: number | null, windowId?: number, opts?: { move?: true }): void;
    /** The room's type picked (decision 93): that site's tab here is followed (fixed), else its first page opens. */
    openSite(site: MediaProvider, windowId?: number): void;
    /**
     * In a room or not, and its site (null: none) — the extension's: in one, the chosen tab is followed and tabs taken
     * over by themselves are of its site only; out of one, the active tab is followed.
     */
    /** `site` undefined: not known yet (a room just opened). */
    setRoom?(room: { inRoom: boolean; site: MediaProvider | null | undefined }): void;
  };
  subscribe?(onChange: () => void): () => void;
  /** The socket went up (or down: null). The extension publishes presence through it. */
  connected?(socket: Socket | null): void;
  /** The background's socket, shared with the screens. */
  connect(handlers: { onEvent(event: ServerEvent): void; onStatus(status: SocketStatus): void }): Socket;
  /** The room's live side, run in the background (it keeps going when the panel closes). */
  room(roomId: string): RoomHandle;
  /** When an invitation or watch request alerted before the panel opened runs out (epoch ms), if known. */
  alertUntil?(kind: "invite" | "request", target: string): number | undefined;
  /** Rooms of mine their host closed (decision 90), to tell about; the same array until it changes (`subscribe`). */
  closedRooms?(): { roomId: string; title: string }[];
  /** Its notice was shown: not again (in any panel). */
  seenClosed?(roomId: string): void;
  /** The host changed the type of the room I'm in (decision 93): to confirm or leave; the same object until it changes. */
  roomTypeNotice?(): { roomId: string; type: MediaProvider; version: number } | null;
  /**
   * That change (`version`) confirmed — the tab followed moves to the room's site then — or leave the room (the
   * extension leaves it; its screen goes back). `always`: this room's later changes are confirmed without asking.
   */
  answerRoomType?(roomId: string, version: number, leave: boolean, always?: boolean): void;
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

/** The text sizes Settings offers, in percent. */
export const TEXT_SIZE = { min: 80, max: 150, step: 5, normal: 100 } as const;

/** A stored text size, or the normal one if it isn't a size offered (in range, on a step). */
export function textSizeOf(value: unknown): number {
  const offered = typeof value === "number" && value >= TEXT_SIZE.min && value <= TEXT_SIZE.max
    && (value - TEXT_SIZE.min) % TEXT_SIZE.step === 0;
  return offered ? value : TEXT_SIZE.normal;
}

// The extension builds its client and platform and hands them over here before rendering. Live ES module
// bindings make the assignment visible to every importer.
export let api: ApiClient;
export let platform: Platform;

export function configure(client: ApiClient, p: Platform) {
  api = client;
  platform = p;
}
