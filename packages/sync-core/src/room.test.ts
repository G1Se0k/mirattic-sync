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


it("keeps a member's player on the credits (the host takes the room on), and lets go on leaving", async () => {
  const m = start("me", "host");
  const credits: (string | null)[] = [];
  (m.player as MockMediaProvider & { keepCredits(id: string | null): void }).keepCredits = (id) => void credits.push(id);
  await measured(m);
  expect(credits.at(-1)).toBe("c1"); // the room's video
  m.sync.dispose();
  expect(credits.at(-1)).toBeNull();

  const h = start("me", "me");
  const hostCredits: (string | null)[] = [];
  (h.player as MockMediaProvider & { keepCredits(id: string | null): void }).keepCredits = (id) => void hostCredits.push(id);
  await measured(h);
  expect(hostCredits.filter((x) => x !== null)).toEqual([]);
  h.sync.dispose();
});

it("asks a member before following the host to another video, unless told to always follow (setting or this room)", async () => {
  const video = (contentId: string) => ({ provider: "youtube" as const, contentId, title: contentId });
  let content = video("aaaaaaaaaaa");
  let ask = true;
  const opened: string[] = [];
  const player = new MockMediaProvider({ contentId: "other", title: "Other", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
    send: () => true, adapter: () => player, nowWatching: () => null, open: (url) => opened.push(url),
    askOnSwitch: () => ask, onChange: () => {},
  });
  sync.setConnected(true);
  const moveTo = async (id: string) => {
    content = video(id);
    sync.handle({ type: "room:update", roomId: "r1", serverTime: Date.now(), payload: null } as ServerEvent);
    await vi.advanceTimersByTimeAsync(0);
  };
  await vi.advanceTimersByTimeAsync(0);
  await moveTo("bbbbbbbbbbb");
  expect(sync.state.switched?.contentId).toBe("bbbbbbbbbbb"); // asked
  sync.openSwitched(true); // "이 방에서 항상 허용"
  expect(opened).toHaveLength(1);
  await moveTo("ccccccccccc");
  expect(opened.at(-1)).toContain("ccccccccccc"); // followed without asking
  expect(sync.state.switched).toBeNull();
  sync.dispose();

  const other = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
    send: () => true, adapter: () => player, nowWatching: () => null, open: (url) => opened.push(url),
    askOnSwitch: () => ask, onChange: () => {},
  });
  other.setConnected(true);
  await vi.advanceTimersByTimeAsync(0);
  ask = false; // the setting: never ask
  content = video("ddddddddddd");
  other.handle({ type: "room:update", roomId: "r1", serverTime: Date.now(), payload: null } as ServerEvent);
  await vi.advanceTimersByTimeAsync(0);
  expect(opened.at(-1)).toContain("ddddddddddd");
  expect(other.state.switched).toBeNull();
  other.dispose();
});

it("opens the room's video in a new tab when a member enters without it, never on a restore or for the host", async () => {
  const content = { provider: "youtube" as const, contentId: "aaaaaaaaaaa", title: "A" };
  const enter = async (host: string, openOnEnter: boolean, playing: string) => {
    const opened: [string, boolean | undefined][] = [];
    const player = new MockMediaProvider({ contentId: playing, title: playing, durationMs: 600_000 });
    const sync = new RoomSync({
      roomId: "r1", meId: "me", loadRoom: async () => ({ ...room(host), content }), isGone: () => false,
      send: () => true, adapter: () => player, nowWatching: () => null, open: (url, newTab) => opened.push([url, newTab]),
      openOnEnter, onChange: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    sync.dispose();
    return opened;
  };
  const opened = await enter("host", true, "other");
  expect(opened).toHaveLength(1);
  expect(opened[0][0]).toContain("aaaaaaaaaaa");
  expect(opened[0][1]).toBe(true); // a new tab: the video the member was on stays
  expect(await enter("host", true, "aaaaaaaaaaa")).toEqual([]); // already open
  expect(await enter("host", false, "other")).toEqual([]); // restored after a worker restart
  expect(await enter("me", true, "other")).toEqual([]); // the host

  // No snapshot yet (the tab still connecting): asked again after a moment, opened only if still not there.
  const late = async (connectsTo: string | null, watching: string | null = null) => {
    const opened: string[] = [];
    let snapshot: string | null = null;
    const player = new MockMediaProvider({ contentId: "x", title: "x", durationMs: 600_000 });
    (player as { getSnapshot(): Promise<unknown> }).getSnapshot = async () => (snapshot === null ? null : { ...(await MockMediaProvider.prototype.getSnapshot.call(player))!, contentId: snapshot });
    const sync = new RoomSync({
      roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
      send: () => true, adapter: () => player, open: (url) => opened.push(url), openOnEnter: true, onChange: () => {},
      nowWatching: () => (watching ? { ...content, contentId: watching } : null),
    });
    await vi.advanceTimersByTimeAsync(0);
    snapshot = connectsTo;
    await vi.advanceTimersByTimeAsync(2_000);
    sync.dispose();
    return opened;
  };
  expect(await late("aaaaaaaaaaa")).toEqual([]); // it was the room's video, just late
  expect(await late(null)).toHaveLength(1); // still nothing: opened
  expect(await late(null, "aaaaaaaaaaa")).toEqual([]); // the browser already shows it

  // While waiting, the room moved to another video: the old one isn't opened.
  const movedOpened: string[] = [];
  let now: RoomView["content"] = content;
  const idle = new MockMediaProvider({ contentId: "x", title: "x", durationMs: 600_000 });
  (idle as { getSnapshot(): Promise<unknown> }).getSnapshot = async () => null;
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content: now }), isGone: () => false,
    send: () => true, adapter: (p) => (p === "youtube" ? idle : undefined), open: (url) => movedOpened.push(url),
    openOnEnter: true, onChange: () => {}, nowWatching: () => null,
  });
  await vi.advanceTimersByTimeAsync(0);
  now = { provider: "netflix", contentId: "81234567", title: "N" }; // no player for it here
  sync.handle({ type: "room:update", roomId: "r1", serverTime: Date.now(), payload: null } as ServerEvent);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(movedOpened).toEqual([]);
  sync.dispose();
});
