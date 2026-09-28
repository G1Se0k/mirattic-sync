import type { ApiClient, Socket } from "@mirattic/client";
import type { MediaProvider, MediaProviderAdapter, RoomContent } from "@mirattic/types";

/** What differs between the desktop app and the extension, besides token storage. */
export type Platform = {
  /** A player this app drives for the provider (mock is built in). undefined = can't play it here. */
  adapter?(provider: MediaProvider): MediaProviderAdapter | undefined;
  /** What the user watches now; "같이 보기" shares it. Must return the same object until it changes. */
  nowWatching?(): RoomContent | null;
  subscribe?(onChange: () => void): () => void;
  /** The socket went up (or down: null). The extension publishes presence through it. */
  connected?(socket: Socket | null): void;
  /** Provider control the user turns on at their own risk (Netflix, Laftel). Absent = not offered in this app. */
  experimental?: {
    enabled(provider: MediaProvider): boolean;
    /** Call from a click: turning on may ask for a browser permission. Changes are announced via `subscribe`. */
    setEnabled(provider: MediaProvider, on: boolean): Promise<boolean>;
  };
  /** Opens a watch page (built with `watchUrl`, never a URL from another user). */
  open(url: string): void;
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
