import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientEvent, RoomView, ServerEvent } from "@mirattic/types";
import { MockMediaProvider } from "./mock";
import { RoomSync } from "./room";

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

const room = (hostId: string): RoomView => ({
  id: "r1", createdAt: 0,
  content: { provider: "laftel", contentId: "c1", title: "Fake", durationMs: 600_000 },
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
  let watching: { provider: "laftel"; contentId: string; title: string; series?: string } | null = { provider: "laftel", contentId: "c1", title: "Fake" };
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
  watching = { provider: "laftel", contentId: "c2", title: "Next" }; // another video: the publisher announces it
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
  const quiet: (boolean | undefined)[] = []; // followed by itself: the tab isn't brought forward
  const player = new MockMediaProvider({ contentId: "other", title: "Other", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
    send: () => true, adapter: () => player, nowWatching: () => null, open: (url, _newTab, q) => (opened.push(url), quiet.push(q)),
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
  expect(quiet.at(-1)).toBeFalsy(); // the user's click: brought forward
  await moveTo("ccccccccccc");
  expect(opened.at(-1)).toContain("ccccccccccc"); // followed without asking
  expect(quiet.at(-1)).toBe(true);
  expect(sync.state.switched).toBeNull();
  sync.dispose();

  const other = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
    send: () => true, adapter: () => player, nowWatching: () => null, open: (url, _newTab, q) => (opened.push(url), quiet.push(q)),
    askOnSwitch: () => ask, onChange: () => {},
  });
  other.setConnected(true);
  await vi.advanceTimersByTimeAsync(0);
  ask = false; // the setting: never ask
  content = video("ddddddddddd");
  other.handle({ type: "room:update", roomId: "r1", serverTime: Date.now(), payload: null } as ServerEvent);
  await vi.advanceTimersByTimeAsync(0);
  expect(opened.at(-1)).toContain("ddddddddddd");
  expect(quiet.at(-1)).toBe(true);
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

it("a room without a video takes the host's first one; the host's player is the site they watch now", async () => {
  // Decision 92: rooms aren't per site. The host's player follows what they watch (any provider).
  type Watching = { provider: "laftel" | "youtube"; contentId: string; title: string };
  let watching: Watching | null = null;
  const sent: ClientEvent[] = [];
  const player = new MockMediaProvider({ contentId: "c1", title: "Fake", durationMs: 600_000 });
  const asked: string[] = [];
  const empty = { ...room("me"), content: null };
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => empty, isGone: () => false,
    send: (e) => (sent.push(e), true),
    adapter: (provider) => (asked.push(provider), provider === "laftel" ? player : undefined),
    nowWatching: () => watching, open: () => {}, onChange: () => {},
  });
  sync.setConnected(true);
  await measured({ sync, sent, player, event: (e) => sync.handle({ serverTime: Date.now(), payload: null, type: "", ...e } as ServerEvent) });
  expect(sync.state.canPlay).toBe(false); // nothing watched, no room video: no player

  watching = { provider: "laftel", contentId: "c1", title: "Fake" };
  sync.refreshPlayer(); // the platform says what is watched changed
  expect(asked.at(-1)).toBe("laftel");
  await player.play();
  await vi.advanceTimersByTimeAsync(500);
  expect(sent.filter((e) => e.type === "playback:content-change").map((e) => e.payload)).toEqual([watching]);

  watching = { provider: "youtube", contentId: "dQw4w9WgXcQ", title: "Other site" };
  sync.refreshPlayer();
  expect(asked.at(-1)).toBe("youtube"); // the room's video is still Laftel's: the host's player is the new site's
  sync.dispose();
});

it("the host moving to another site's video with the same id announces it (the site is part of the video)", async () => {
  const watching = { provider: "youtube" as const, contentId: "c1", title: "Same id, other site" };
  const sent: ClientEvent[] = [];
  const mock = new MockMediaProvider({ contentId: "c1", title: "Fake", durationMs: 600_000 });
  const youtube = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => room("me"), isGone: () => false, // the room's video: mock "c1"
    send: (e) => (sent.push(e), true), adapter: (p) => (p === "youtube" ? youtube : undefined),
    nowWatching: () => watching, open: () => {}, onChange: () => {},
  });
  sync.setConnected(true);
  await measured({ sync, sent, player: mock, event: (e) => sync.handle({ serverTime: Date.now(), payload: null, type: "", ...e } as ServerEvent) });
  await youtube.play();
  await vi.advanceTimersByTimeAsync(500);
  expect(sent.filter((e) => e.type === "playback:content-change").map((e) => e.payload)).toEqual([watching]);
  sync.dispose();
});

it("drops a member's prompt to follow a video once the room moved on to another (another site too)", async () => {
  let content: RoomView["content"] = { provider: "youtube", contentId: "aaaaaaaaaaa", title: "First" };
  const mock = new MockMediaProvider({ contentId: "aaaaaaaaaaa", title: "First", durationMs: 600_000 });
  const youtube = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
    send: () => true, adapter: (p) => (p === "youtube" ? youtube : undefined), nowWatching: () => null, open: () => {},
    onChange: () => {}, askOnSwitch: () => true,
  });
  sync.setConnected(true);
  await settle();
  content = { provider: "youtube", contentId: "bbbbbbbbbbb", title: "Next" }; // not the same series: asked
  await sync.reload();
  await settle();
  expect(sync.state.switched?.contentId).toBe("bbbbbbbbbbb");
  content = { provider: "netflix", contentId: "81234567", title: "Other site" }; // no player for it here
  await sync.reload();
  await settle();
  expect(sync.state.switched).toBeNull();
  sync.dispose();
});

it("a room entered without a video opens its first one; a restored one (not entered now) opens nothing", async () => {
  for (const entering of [true, false]) {
    let content: RoomView["content"] = null;
    const opened: string[] = [];
    const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
    const youtube = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
    const sync = new RoomSync({
      roomId: "r1", meId: "me", loadRoom: async () => ({ ...room("host"), content }), isGone: () => false,
      send: () => true, adapter: (p) => (p === "youtube" ? youtube : undefined), nowWatching: () => null,
      open: (url) => void opened.push(url), onChange: () => {}, openOnEnter: entering,
    });
    sync.setConnected(true);
    await settle();
    content = { provider: "youtube", contentId: "aaaaaaaaaaa", title: "First" };
    await sync.reload();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(opened).toEqual(entering ? ["https://www.youtube.com/watch?v=aaaaaaaaaaa"] : []);
    sync.dispose();
  }
});

it("a member who hasn't confirmed the room's type change isn't moved to another site's video (their confirmation does it)", async () => {
  let view: RoomView = { ...room("host"), content: { provider: "youtube", contentId: "aaaaaaaaaaa", title: "First" }, type: "youtube", typeVersion: 0, typeSeen: 0 };
  const opened: string[] = [];
  const mock = new MockMediaProvider({ contentId: "aaaaaaaaaaa", title: "First", durationMs: 600_000 });
  const any = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => any, nowWatching: () => null, open: (url) => void opened.push(url), onChange: () => {},
    askOnSwitch: () => false, // would follow without asking
  });
  sync.setConnected(true);
  await settle();
  view = { ...view, content: { provider: "netflix", contentId: "81234567", title: "Other site" }, type: "netflix", typeVersion: 1 };
  await sync.reload();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opened).toEqual([]);
  expect(sync.state.switched).toBeNull();
  // Another video of the new site before confirming: still not followed.
  view = { ...view, content: { provider: "netflix", contentId: "81234569", title: "Another" } };
  await sync.reload();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opened).toEqual([]);
  expect(sync.state.switched).toBeNull();
  // Confirmed (seen), then the host moves on within that site: followed (moved to it once).
  view = { ...view, content: { provider: "netflix", contentId: "81234568", title: "Next" }, typeSeen: 1 };
  sync.confirmType(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opened).toEqual(["https://www.netflix.com/watch/81234568"]);
  sync.dispose();
});

it("entering a room without a video: its first video after an unconfirmed type change doesn't open", async () => {
  let view: RoomView = { ...room("host"), content: null, type: null, typeVersion: 0, typeSeen: 0 };
  const opened: string[] = [];
  const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
  const any = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => any, nowWatching: () => null, open: (url) => void opened.push(url), onChange: () => {}, openOnEnter: true,
  });
  sync.setConnected(true);
  await settle();
  view = { ...view, content: { provider: "youtube", contentId: "aaaaaaaaaaa", title: "First" }, type: "youtube", typeVersion: 1 };
  await sync.reload();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(opened).toEqual([]);
  sync.dispose();
});

it("a type change without a new video drops a pending prompt to follow (until confirmed)", async () => {
  let view: RoomView = { ...room("host"), content: { provider: "youtube", contentId: "aaaaaaaaaaa", title: "First" }, type: "youtube", typeVersion: 0, typeSeen: 0 };
  const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
  const any = new Proxy(mock, { get: (t, k) => (k === "provider" ? "youtube" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => any, nowWatching: () => null, open: () => {}, onChange: () => {}, askOnSwitch: () => true,
  });
  sync.setConnected(true);
  await settle();
  view = { ...view, content: { provider: "youtube", contentId: "bbbbbbbbbbb", title: "Next" } };
  await sync.reload();
  await settle();
  expect(sync.state.switched?.contentId).toBe("bbbbbbbbbbb");
  view = { ...view, type: "netflix", typeVersion: 1 }; // the type changed, the video not yet
  await sync.reload();
  await settle();
  expect(sync.state.switched).toBeNull();
  sync.dispose();
});

it("a member isn't synced (no playback applied) until they confirm the room's type change", async () => {
  let view: RoomView = { ...room("host"), type: "laftel", typeVersion: 1, typeSeen: 0 };
  const m = start("me", "host");
  m.sync["deps"].loadRoom = async () => view;
  await m.sync.reload();
  await measured(m);
  m.event({ type: "playback:update", roomId: "r1", payload: { provider: "laftel", contentId: "c1", positionMs: 300_000, playing: true, capturedAt: Date.now(), version: 5 } });
  await vi.advanceTimersByTimeAsync(3_000);
  expect((await m.player.getSnapshot())!.playing).toBe(false); // not driven while unconfirmed
  view = { ...view, typeSeen: 1 }; // confirmed
  await m.sync.reload();
  await vi.advanceTimersByTimeAsync(3_000);
  expect((await m.player.getSnapshot())!.playing).toBe(true);
  m.sync.dispose();
});

it("confirming a type change moves the member's tab once, in place: to the room's video of that site, else the site", async () => {
  for (const [content, expected] of [
    [{ provider: "netflix", contentId: "81234567", title: "On it" }, "https://www.netflix.com/watch/81234567"],
    [{ provider: "youtube", contentId: "aaaaaaaaaaa", title: "Old site" }, "https://www.netflix.com/browse"],
  ] as const) {
    let view: RoomView = { ...room("host"), content, type: "netflix", typeVersion: 1, typeSeen: 0 };
    const opened: [string, boolean | undefined][] = [];
    const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
    const sync = new RoomSync({
      roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
      adapter: () => mock, nowWatching: () => null, open: (url, newTab) => void opened.push([url, newTab]), onChange: () => {},
      askOnSwitch: () => false, siteUrl: (p) => (p === "netflix" ? "https://www.netflix.com/browse" : undefined),
    });
    sync.setConnected(true);
    await settle();
    expect(opened).toEqual([]); // unconfirmed
    view = { ...view, typeSeen: 1 };
    sync.confirmType(1); // confirmed here
    await vi.advanceTimersByTimeAsync(3_000);
    expect(opened).toEqual([[expected, undefined]]); // once, in the tab followed
    sync.dispose();
  }
});

it("entering a room whose type moved on from its video opens the type's site, not the old video", async () => {
  const view: RoomView = { ...room("host"), content: { provider: "youtube", contentId: "aaaaaaaaaaa", title: "Old" }, type: "netflix", typeVersion: 1, typeSeen: 1 };
  const opened: [string, boolean | undefined][] = [];
  const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => mock, nowWatching: () => null, open: (url, newTab) => void opened.push([url, newTab]), onChange: () => {},
    openOnEnter: true, siteUrl: (p) => (p === "netflix" ? "https://www.netflix.com/browse" : undefined),
  });
  sync.setConnected(true);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(opened).toEqual([["https://www.netflix.com/browse", true]]);
  sync.dispose();
});

it("confirming while the room's video moved on too: one move, to the newer video", async () => {
  let view: RoomView = { ...room("host"), content: { provider: "netflix", contentId: "81234567", title: "A" }, type: "netflix", typeVersion: 1, typeSeen: 0 };
  const opened: string[] = [];
  const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
  const netflix = new Proxy(mock, { get: (t, k) => (k === "provider" ? "netflix" : Reflect.get(t, k, t)) });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => netflix, nowWatching: () => null, open: (url) => void opened.push(url), onChange: () => {},
    askOnSwitch: () => false, siteUrl: () => "https://www.netflix.com/browse",
  });
  sync.setConnected(true);
  await settle();
  view = { ...view, content: { provider: "netflix", contentId: "81234568", title: "B" }, typeSeen: 1 };
  sync.confirmType(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(opened).toEqual(["https://www.netflix.com/watch/81234568"]);
  sync.dispose();
});

it("confirmed before this sync ever saw the change pending: still moves once the room says so", async () => {
  let view: RoomView = { ...room("host"), content: { provider: "youtube", contentId: "aaaaaaaaaaa", title: "Old" }, type: "youtube", typeVersion: 0, typeSeen: 0 };
  const opened: string[] = [];
  const mock = new MockMediaProvider({ contentId: "zzzzzzzzzzz", title: "Else", durationMs: 600_000 });
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => mock, nowWatching: () => null, open: (url) => void opened.push(url), onChange: () => {},
    siteUrl: () => "https://www.netflix.com/browse",
  });
  sync.setConnected(true);
  await settle();
  view = { ...view, type: "netflix", typeVersion: 1, typeSeen: 1 }; // changed and confirmed before any reload here
  sync.confirmType(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(opened).toEqual(["https://www.netflix.com/browse"]);
  sync.dispose();
});

it("entering a room whose type moved on opens the type's site even if the old video's site can't play here", async () => {
  const view: RoomView = { ...room("host"), content: { provider: "netflix", contentId: "81234567", title: "Old" }, type: "youtube", typeVersion: 1, typeSeen: 1 };
  const opened: string[] = [];
  const sync = new RoomSync({
    roomId: "r1", meId: "me", loadRoom: async () => view, isGone: () => false, send: () => true,
    adapter: () => undefined, nowWatching: () => null, open: (url) => void opened.push(url), onChange: () => {},
    openOnEnter: true, siteUrl: () => "https://www.youtube.com/",
  });
  sync.setConnected(true);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(opened).toEqual(["https://www.youtube.com/"]);
  sync.dispose();
});
