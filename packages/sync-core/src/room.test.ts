import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientEvent, RoomView, ServerEvent } from "@mirattic/types";
import { MockMediaProvider } from "./mock";
import { RoomSync } from "./room";

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

const room = (hostId: string): RoomView => ({
  id: "r1", createdAt: 0, unread: 0, muted: false,
  content: { provider: "mock", contentId: "c1", title: "Fake", durationMs: 600_000 },
  members: [
    { user: { id: "host", displayName: "Host" }, role: hostId === "host" ? "HOST" : "MEMBER", present: true },
    { user: { id: "me", displayName: "Me" }, role: hostId === "me" ? "HOST" : "MEMBER", present: true },
  ],
});

function start(meId: string, hostId: string) {
  const sent: ClientEvent[] = [];
  const player = new MockMediaProvider({ contentId: "c1", title: "Fake", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId, loadRoom: async () => room(hostId), isGone: () => false,
    send: (e) => (sent.push(e), true), adapter: () => player, nowWatching: () => null, open: () => {},
    onChange: () => {},
  });
  sync.setConnected(true);
  const event = (e: Partial<ServerEvent>) => sync.handle({ serverTime: Date.now(), payload: null, type: "", ...e } as ServerEvent);
  return { sync, sent, player, event };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

async function measured(r: ReturnType<typeof start>) {
  await vi.advanceTimersByTimeAsync(1_000); // the clock requests go out
  for (const e of r.sent.filter((e) => e.type === "sync:request")) r.event({ type: "sync:response", payload: { reqId: e.reqId } });
  await settle();
}

it("sends a member's pause request once per 30 seconds; the host can't send one", async () => {
  const m = start("me", "host");
  await measured(m);
  const requests = () => m.sent.filter((e) => e.type === "pause:request");
  m.sync.requestPause("  잠깐만요  ");
  expect(requests()).toEqual([{ type: "pause:request", roomId: "r1", payload: { reason: "잠깐만요" } }]);
  m.sync.requestPause("again");
  expect(requests()).toHaveLength(1); // cooldown
  let changes = 0;
  const onChange = m.sync["deps"].onChange;
  m.sync["deps"].onChange = (s) => (changes++, onChange(s));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(changes).toBeGreaterThan(0); // the screen is told the cooldown is over
  m.sync.requestPause();
  expect(requests()).toHaveLength(2);
  m.sync.dispose();

  const h = start("me", "me");
  await measured(h);
  h.sync.requestPause();
  expect(h.sent.filter((e) => e.type === "pause:request")).toEqual([]);
  h.sync.dispose();
});

it("shows the host a member's pause request for 30 seconds", async () => {
  const h = start("me", "me");
  await measured(h);
  h.event({ type: "pause:request", roomId: "r1", userId: "host", payload: { reason: "화장실" } });
  expect(h.sync.state.pauseRequest).toMatchObject({ userId: "host", name: "Host", reason: "화장실" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.sync.state.pauseRequest).toBeNull();
  h.sync.dispose();
  expect(h.sent.at(-1)).toEqual({ type: "room:leave", roomId: "r1", payload: {} });
});

it("tells the room when the host's video gets its details later (same video, no restart)", async () => {
  let watching: { provider: "mock"; contentId: string; title: string; series?: string } | null = { provider: "mock", contentId: "c1", title: "Fake" };
  const sent: ClientEvent[] = [];
  const player = new MockMediaProvider({ contentId: "c1", title: "Fake", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => room("me"), isGone: () => false,
    send: (e) => (sent.push(e), true), adapter: () => player, nowWatching: () => watching, open: () => {},
    onChange: () => {},
  });
  sync.setConnected(true);
  await settle();
  sync.watchingChanged(); // nothing new
  expect(sent.filter((e) => e.type === "playback:content-change")).toEqual([]);
  watching = { ...watching!, title: "Kingdom S2:E3", series: "80100172" };
  sync.watchingChanged();
  expect(sent.filter((e) => e.type === "playback:content-change").map((e) => e.payload)).toEqual([watching]);
  // Offline when the final title arrives: sent once the connection is back.
  sync.setConnected(false);
  watching = { ...watching!, title: "Kingdom S2:E3 · Final" };
  sync.watchingChanged();
  expect(sent.filter((e) => e.type === "playback:content-change")).toHaveLength(1);
  sync.setConnected(true);
  expect(sent.filter((e) => e.type === "playback:content-change").at(-1)?.payload).toEqual(watching);
  const before = sent.filter((e) => e.type === "playback:content-change").length;
  watching = { provider: "mock", contentId: "c2", title: "Next" }; // another video: the publisher announces it
  sync.watchingChanged();
  expect(sent.filter((e) => e.type === "playback:content-change")).toHaveLength(before);
  sync.dispose();
});

