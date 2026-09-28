import type { ApiClient } from "@mirattic/client";

// Each app (desktop, extension) builds its own client — token storage differs — and hands it over here
// before rendering. Live ES module bindings make the assignment visible to every importer.
export let api: ApiClient;
export let SOCKET_URL: string;

export function configure(client: ApiClient, socketUrl: string) {
  api = client;
  SOCKET_URL = socketUrl;
}
