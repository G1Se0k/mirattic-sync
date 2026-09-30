import type { ClientEvent, ServerEvent } from "@mirattic/types";
import { ApiError } from "./api";

/** `replaced`: another device of the account connected (decision 89); no reconnecting until `resume()`. */
export type SocketStatus = "connecting" | "open" | "closed" | "replaced";

export type Socket = {
  send(event: ClientEvent): boolean;
  close(): void;
  /** Connects again after `replaced` (this device takes over; the other one is replaced in turn). */
  resume(): void;
};

/** The server's close code for a connection another device replaced. */
export const REPLACED_CODE = 4001;

/**
 * WebSocket with a fresh one-time ticket per attempt and capped exponential backoff.
 * Stops for good when the ticket request says the session is gone (401).
 */
export function connectSocket(opts: {
  url: string;
  getTicket: () => Promise<string>;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: SocketStatus) => void;
}): Socket {
  let ws: WebSocket | null = null;
  let closed = false;
  /** Replaced by another device: waiting for `resume()`, not reconnecting. */
  let replaced = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function open() {
    if (closed) return;
    opts.onStatus?.("connecting");
    let ticket: string;
    try {
      ticket = await opts.getTicket();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        closed = true;
        opts.onStatus?.("closed");
        return;
      }
      return retry();
    }
    if (closed) return;
    ws = new WebSocket(`${opts.url}?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => {
      attempt = 0;
      opts.onStatus?.("open");
    };
    ws.onmessage = (m) => {
      try {
        const event = JSON.parse(m.data);
        if (event?.type === "session:replaced") replaced = true; // the close follows
        else opts.onEvent(event);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (e) => {
      ws = null;
      if (closed) return; // closed here (signed out): nothing more to tell
      if (replaced || e.code === REPLACED_CODE) {
        replaced = true;
        opts.onStatus?.("replaced");
        return;
      }
      retry();
    };
  }

  function retry() {
    if (closed) return;
    opts.onStatus?.("connecting");
    const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
    timer = setTimeout(open, delay);
  }

  void open();

  return {
    send(event) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(event));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
      opts.onStatus?.("closed");
    },
    resume() {
      if (!replaced || closed) return;
      replaced = false;
      attempt = 0;
      void open();
    },
  };
}

/** http://host:8080 → ws://host:8080/ws */
export function socketUrl(baseUrl: string) {
  return baseUrl.replace(/^http/, "ws") + "/ws";
}
