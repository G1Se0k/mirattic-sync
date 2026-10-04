import { afterEach, expect, it, vi } from "vitest";
import { connectSocket, REPLACED_CODE, type SocketStatus } from "./socket";

/** A WebSocket stand-in the test drives: open, message, close. */
class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}

afterEach(() => vi.useRealTimers());

it("stops on a replacement (no reconnect) and connects again on resume", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const statuses: SocketStatus[] = [];
  const getTicket = vi.fn(async () => "t");
  const socket = connectSocket({ url: "ws://x/ws", getTicket, onEvent: () => {}, onStatus: (s) => statuses.push(s) });
  await vi.runAllTimersAsync();
  FakeSocket.last.onopen?.();

  FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: "session:replaced", serverTime: 0, payload: null }) });
  FakeSocket.last.onclose?.({ code: REPLACED_CODE });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statuses.at(-1)).toBe("replaced");
  expect(getTicket).toHaveBeenCalledTimes(1); // stayed off

  socket.resume();
  await vi.runAllTimersAsync();
  expect(getTicket).toHaveBeenCalledTimes(2);
  FakeSocket.last.onopen?.();
  expect(statuses.at(-1)).toBe("open");

  // An ordinary drop still reconnects.
  FakeSocket.last.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getTicket).toHaveBeenCalledTimes(3);
  vi.unstubAllGlobals();
});

it("a socket closed here (signed out) reports no replacement afterwards", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const statuses: SocketStatus[] = [];
  const socket = connectSocket({ url: "ws://x/ws", getTicket: async () => "t", onEvent: () => {}, onStatus: (s) => statuses.push(s) });
  await vi.runAllTimersAsync();
  FakeSocket.last.onopen?.();
  FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: "session:replaced", serverTime: 0, payload: null }) });
  socket.close();
  FakeSocket.last.onclose?.({ code: REPLACED_CODE }); // the close lands after
  expect(statuses.at(-1)).toBe("closed");
  vi.unstubAllGlobals();
});

it("logs a handler's error instead of dropping it as a bad frame, and keeps delivering", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const seen: string[] = [];
  connectSocket({
    url: "ws://x/ws",
    getTicket: async () => "t",
    onEvent: (e) => {
      if (e.type === "boom") throw new Error("handler bug");
      seen.push(e.type);
    },
  });
  await vi.runAllTimersAsync();
  FakeSocket.last.onopen?.();
  FakeSocket.last.onmessage?.({ data: "not json" }); // malformed: ignored quietly
  FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: "boom", serverTime: 0, payload: null }) });
  FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: "after", serverTime: 0, payload: null }) });
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0][1]).toBe("boom");
  expect(seen).toEqual(["after"]);
  errors.mockRestore();
});
