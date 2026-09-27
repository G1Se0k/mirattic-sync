import type { ClientEvent, ServerEvent } from "@mirattic/types";
import { ApiError } from "./api";

export type SocketStatus = "connecting" | "open" | "closed";

export type Socket = {
  send(event: ClientEvent): boolean;
  close(): void;
};

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
        opts.onEvent(JSON.parse(m.data));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      ws = null;
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
  };
}

/** http://host:8080 → ws://host:8080/ws */
export function socketUrl(baseUrl: string) {
  return baseUrl.replace(/^http/, "ws") + "/ws";
}
