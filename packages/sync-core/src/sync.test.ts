import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProviderAdapter, PlaybackCommand, PlaybackState, PlayerSnapshot } from "@mirattic/types";
import { ServerClock } from "./clock";
import { MockMediaProvider } from "./mock";
import { classifyDrift, estimatePosition, publishHost, SyncFollower, type FollowerStatus } from "./sync";

const CONTENT = { contentId: "c1", title: "Fake", durationMs: 600_000 };

function state(over: Partial<PlaybackState> = {}): PlaybackState {
  return {
    provider: "mock", contentId: "c1", durationMs: 600_000, positionMs: 0, playing: false,
    capturedAt: Date.now(), sourceUserId: "host", version: 1, ...over,
  };
}

/** A member whose local clock runs 5s ahead of the server; the clock sync measures that. */
function member() {
  const localNow = () => Date.now() + 5000;
  const clock = new ServerClock(localNow);
  clock.addSample(localNow(), Date.now(), localNow());
  const player = new MockMediaProvider(CONTENT, localNow);
  const statuses: FollowerStatus[] = [];
  const follower = new SyncFollower({ adapter: player, clock, onStatus: (s) => statuses.push(s) });
  return { player, follower, statuses };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("ServerClock", () => {
  it("trusts the lowest-RTT sample", () => {
    let t = 0;
    const clock = new ServerClock(() => t);
    clock.addSample(0, 1_050, 100); // rtt 100 → offset 1000
    clock.addSample(200, 1_900, 1_000); // rtt 800, skewed by queuing → offset 1300
    expect(clock.offset()).toBe(1000);
    t = 5;
    expect(clock.serverNow()).toBe(1005);
  });
});

describe("estimatePosition / classifyDrift", () => {
  it("extrapolates only while playing and clamps to duration", () => {
    const s = state({ positionMs: 10_000, capturedAt: 0, durationMs: 12_000 });
    expect(estimatePosition(s, 1_000)).toBe(10_000);
    expect(estimatePosition({ ...s, playing: true }, 1_000)).toBe(11_000);
    expect(estimatePosition({ ...s, playing: true }, 9_000)).toBe(12_000);
  });

  it("follows the drift policy and provider overrides", () => {
    expect([499, 500, 1500, 1501, 3001].map((d) => classifyDrift(d))).toEqual([
      "ignore", "recheck", "recheck", "seek", "immediate",
    ]);
    expect(classifyDrift(-2000)).toBe("seek");
    expect(classifyDrift(800, { ignoreBelowMs: 1000, seekAboveMs: 2000, immediateAboveMs: 4000 })).toBe("ignore");
  });
});

describe("SyncFollower", () => {
  it("undoes a member's own pause: only the host pauses the room", async () => {
    const m = member();
    m.follower.apply(state({ playing: true, capturedAt: Date.now() }));
    await settle();
    await m.player.pause();
    await settle();
    expect(m.player.isPlaying()).toBe(true);
  });

  it("tries play again when the player didn't take it (autoplay refused), even with no drift", async () => {
    const m = member();
    let refuse = true;
    const play = m.player.play.bind(m.player);
    m.player.play = async () => (refuse ? undefined : play());
    m.follower.apply(state({ playing: true, positionMs: 0, capturedAt: Date.now() }));
    await settle();
    expect(m.player.isPlaying()).toBe(false);
    refuse = false; // the user clicked the page once, say
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.player.isPlaying()).toBe(true);
  });

  it("keeps checking while there is no player yet", async () => {
    const m = member();
    const snapshot = m.player.getSnapshot.bind(m.player);
    let ready = false;
    (m.player as MediaProviderAdapter).getSnapshot = async () => (ready ? snapshot() : null);
    m.follower.apply(state({ positionMs: 10_000, playing: true, capturedAt: Date.now() }));
    await settle();
    expect(m.statuses.at(-1)).toEqual({ kind: "waiting" });
    ready = true; // the tab answers, without any event
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.player.isPlaying()).toBe(true);
  });

  it("joins a playing room at the extrapolated position despite clock skew", async () => {
    const m = member();
    m.follower.apply(state({ positionMs: 10_000, playing: true, capturedAt: Date.now() - 1_000 }));
    await settle();
    expect(m.player.isPlaying()).toBe(true);
    expect(m.player.positionMs()).toBe(11_000);
  });

  it("drops stale versions", async () => {
    const m = member();
    expect(m.follower.apply(state({ version: 5, positionMs: 50_000 }))).toBe(true);
    expect(m.follower.apply(state({ version: 4, positionMs: 1_000 }))).toBe(false);
    expect(m.follower.apply(state({ version: 5, positionMs: 1_000 }))).toBe(false);
    await settle();
    expect(m.player.positionMs()).toBe(50_000);
  });

  it("ignores small drift, rechecks medium drift, confirms then seeks, corrects large drift at once", async () => {
    const m = member();
    m.follower.apply(state({ positionMs: 100_000, playing: true }));
    await settle();

    await m.player.seek(m.player.positionMs() + 300);
    await settle();
    expect(m.statuses.at(-1)).toEqual({ kind: "synced", driftMs: 300 });

    await m.player.seek(m.player.positionMs() + 700); // now +1000
    await settle();
    expect(m.statuses.at(-1)).toEqual({ kind: "rechecking", driftMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.statuses.at(-1)).toEqual({ kind: "rechecking", driftMs: 1000 }); // still tolerated

    await m.player.seek(m.player.positionMs() - 3000); // now −2000: may be a blip
    await settle();
    expect(m.statuses.at(-1)).toMatchObject({ kind: "confirming" });
    const before = m.player.positionMs();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.statuses.at(-2)).toEqual({ kind: "corrected", driftMs: -2000 });
    expect(m.player.positionMs()).toBe(before + 1000 + 2000);

    await m.player.seek(0); // far off: no confirmation wait
    await settle();
    expect(m.statuses).toContainEqual({ kind: "corrected", driftMs: -102_000 });
    expect(m.player.positionMs()).toBe(102_000);
  });

  it("corrects a seek-band drift at once when the host caused it", async () => {
    const m = member();
    m.follower.apply(state({ positionMs: 100_000, playing: true }));
    await settle();
    m.follower.apply(state({ version: 2, positionMs: 98_000, playing: true }));
    await settle();
    expect(m.player.positionMs()).toBe(98_000);
  });

  it("keeps the host-event flag when a new state arrives mid-evaluation", async () => {
    const m = member();
    m.follower.apply(state({ positionMs: 0 }));
    m.follower.apply(state({ version: 2, positionMs: 2_000 })); // before the first check settles
    await settle();
    expect(m.player.positionMs()).toBe(2_000);
    expect(m.statuses.map((s) => s.kind)).not.toContain("confirming");
  });

  it("pauses on a host pause and leaves an ad alone", async () => {
    const m = member();
    m.follower.apply(state({ positionMs: 10_000, playing: true }));
    await settle();
    m.follower.apply(state({ version: 2, positionMs: 10_000, playing: false }));
    await settle();
    expect(m.player.isPlaying()).toBe(false);

    const snapshot = m.player.snapshot.bind(m.player);
    m.player.getSnapshot = async () => ({ ...snapshot(), adPlaying: true });
    m.follower.apply(state({ version: 3, positionMs: 90_000, playing: true }));
    await settle();
    expect(m.statuses.at(-1)).toEqual({ kind: "ad" });
    expect(m.player.positionMs()).toBe(10_000);
  });

  it("never seeks an unseekable player: plays along and says where to go", async () => {
    const m = member();
    Object.assign(m.player, { seekable: false });
    m.follower.apply(state({ positionMs: 60_000, playing: true }));
    await settle();
    expect(m.player.isPlaying()).toBe(true);
    expect(m.player.positionMs()).toBe(0);
    expect(m.statuses.at(-1)).toMatchObject({ kind: "manual", targetMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.statuses.at(-1)).toMatchObject({ kind: "manual", targetMs: 61_000 });
  });
});

describe("host → server → member", () => {
  it("mirrors host play, seek and pause", async () => {
    // Stand-in for the server: stamps version, keeps the host's server-time capturedAt.
    let version = 0;
    const m = member();
    const relay = (type: string, cmd: PlaybackCommand) =>
      m.follower.apply(state({ ...cmd, playing: type === "playback:seek" ? host.isPlaying() : type === "playback:play", version: ++version }));

    const hostClock = new ServerClock(() => Date.now() - 2000); // host clock 2s behind
    hostClock.addSample(Date.now() - 2000, Date.now(), Date.now() - 2000);
    const host = new MockMediaProvider(CONTENT, () => Date.now() - 2000);
    publishHost(host, hostClock, relay);
    await settle();

    await vi.advanceTimersByTimeAsync(1_000);
    await host.play();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.player.isPlaying()).toBe(true);
    expect(Math.abs(m.player.positionMs() - host.positionMs())).toBeLessThan(500);

    await host.seek(300_000);
    await settle();
    expect(m.player.positionMs()).toBe(300_000);

    // A seek right after a pause is delayed to the next window, not dropped.
    await vi.advanceTimersByTimeAsync(1_000);
    await host.pause();
    await host.seek(200_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(m.player.isPlaying()).toBe(false);
    expect(m.player.positionMs()).toBe(200_000);
    // Three changes inside one window go out as one command with the final state.
    await host.play();
    await host.seek(250_000);
    await host.seek(300_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(version).toBe(6);

    await vi.advanceTimersByTimeAsync(2_000);
    await host.pause();
    await settle();
    expect(m.player.isPlaying()).toBe(false);
    expect(m.player.positionMs()).toBe(host.positionMs());
    expect(version).toBe(7);
  });
});

describe("publishHost", () => {
  it("pauses members where the video was when it goes away, and resumes with a play", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    const host: MockMediaProvider & MediaProviderAdapter = new MockMediaProvider(CONTENT);
    let goneListener = () => {};
    host.onGone = (cb: () => void) => ((goneListener = cb), () => {});
    const sent: [string, PlaybackCommand, boolean | undefined][] = [];
    publishHost(host, clock, (type, cmd, _s, gone) => void sent.push([type, cmd, gone]));
    await settle();
    await host.seek(10_000);
    await host.play();
    await vi.advanceTimersByTimeAsync(3_000);
    sent.length = 0;

    goneListener(); // left the watch page while playing
    expect(sent).toEqual([["playback:pause", { positionMs: 13_000, capturedAt: Date.now() }, true]]);
    goneListener(); // already paused: nothing more
    expect(sent).toHaveLength(1);

    await host.seek(20_000); // back on the video and playing again
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.at(-1)?.[0]).toBe("playback:play");
  });

  it("republishes the current state when restarted after a disconnect", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    const host = new MockMediaProvider(CONTENT);
    const sent: [string, PlaybackCommand][] = [];
    const stop = publishHost(host, clock, (type, cmd) => void sent.push([type, cmd]));
    await settle();
    await host.play();
    await vi.advanceTimersByTimeAsync(200);
    stop(); // socket closed

    await host.seek(42_000);
    await host.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);

    publishHost(host, clock, (type, cmd) => void sent.push([type, cmd])); // reconnected
    await settle();
    expect(sent.at(-1)).toEqual(["playback:pause", { positionMs: 42_000, capturedAt: Date.now() }]);
  });

  it("says whether the host holds the seek bar, where the page tells (decision 86)", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    const host = new MockMediaProvider(CONTENT);
    const snapshot = host.snapshot.bind(host);
    let scrubbing: boolean | undefined = true;
    host.getSnapshot = async () => ({ ...snapshot(), scrubbing });
    const sent: [string, PlaybackCommand][] = [];
    publishHost(host, clock, (type, cmd) => void sent.push([type, cmd]));
    await settle();
    await host.play();
    await vi.advanceTimersByTimeAsync(200);
    await host.pause();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.at(-1)).toEqual(["playback:pause", expect.objectContaining({ scrubbing: true })]);
    scrubbing = undefined; // a page that can't tell: no flag at all
    await host.play();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.at(-1)?.[1]).not.toHaveProperty("scrubbing");
  });

  it("never publishes an ad's position", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    const host = new MockMediaProvider(CONTENT);
    const snapshot = host.snapshot.bind(host);
    let ad = true;
    const onChange = host.onChange.bind(host);
    host.getSnapshot = async () => ({ ...snapshot(), adPlaying: ad });
    host.onChange = (cb) => onChange((s) => cb({ ...s, adPlaying: ad }));
    const sent: [string, PlaybackCommand][] = [];
    publishHost(host, clock, (type, cmd) => void sent.push([type, cmd]));
    await settle();
    await host.play(); // the ad starts playing
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([]);

    // A change queued in the rate window is dropped if an ad starts before it goes out —
    // announced by an event, or not yet (the adapter only notices ads by polling).
    ad = false;
    await host.seek(1_000);
    await host.seek(2_000); // waits for the window
    ad = true;
    await host.play();
    await vi.advanceTimersByTimeAsync(1_000);
    ad = false;
    await host.seek(3_000);
    await host.seek(4_000); // waits for the window
    ad = true; // no event
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.map(([, c]) => c.positionMs)).toEqual([1_000, 3_000]);
    sent.length = 0;

    ad = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const at = Date.now();
    await host.seek(5_000); // content resumes
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([["playback:seek", { positionMs: 5_000, capturedAt: at }]]);
  });

  it("sends the state read at send time: never a queued one from the previous video or a lost player", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    let current: PlayerSnapshot | null = { contentId: "a", positionMs: 1_000, playing: true, capturedAt: Date.now() };
    let reply = Promise.resolve();
    const listeners = new Set<(s: PlayerSnapshot) => void>();
    const adapter = {
      ...new MockMediaProvider(CONTENT),
      getSnapshot: async () => {
        await reply;
        return current && { ...current, capturedAt: Date.now() };
      },
      onChange: (cb: (s: PlayerSnapshot) => void) => (listeners.add(cb), () => void listeners.delete(cb)),
    } as unknown as MockMediaProvider;
    const change = (s: PlayerSnapshot | null) => {
      current = s;
      if (s) listeners.forEach((l) => l(s));
    };
    const sent: [string, number, string][] = [];
    let skip = false;
    publishHost(adapter, clock, (type, cmd, snap) => !skip && sent.push([type, cmd.positionMs, snap.contentId]) > 0);
    await settle();
    expect(sent).toEqual([["playback:play", 1_000, "a"]]);

    change({ contentId: "a", positionMs: 5_000, playing: true, capturedAt: Date.now() }); // queued
    current = { contentId: "b", positionMs: 0, playing: true, capturedAt: Date.now() }; // next video autoplays
    await vi.advanceTimersByTimeAsync(200);
    // The room restarts paused on a new video, so "still playing" must be said as a play, not a seek.
    expect(sent.at(-1)).toEqual(["playback:play", 0, "b"]);

    // A command the caller skipped (e.g. metadata not there yet) is not remembered as sent.
    skip = true;
    await vi.advanceTimersByTimeAsync(1_000);
    change({ contentId: "c", positionMs: 0, playing: true, capturedAt: Date.now() });
    await settle();
    skip = false;
    await vi.advanceTimersByTimeAsync(1_000);
    change({ contentId: "c", positionMs: 500, playing: true, capturedAt: Date.now() });
    await settle();
    expect(sent.at(-1)).toEqual(["playback:play", 500, "c"]);

    await vi.advanceTimersByTimeAsync(1_000);
    change({ contentId: "c", positionMs: 7_000, playing: true, capturedAt: Date.now() });
    await settle();
    change({ contentId: "c", positionMs: 8_000, playing: true, capturedAt: Date.now() }); // queued
    current = null; // the tab went away
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.at(-1)).toEqual(["playback:seek", 7_000, "c"]);

    // A slow read overtaken by a newer flush is dropped: only the newer state goes out.
    let release!: () => void;
    reply = new Promise((r) => (release = r));
    change({ contentId: "c", positionMs: 9_000, playing: false, capturedAt: Date.now() }); // flush 1 waits
    await vi.advanceTimersByTimeAsync(1_000);
    change({ contentId: "c", positionMs: 9_500, playing: false, capturedAt: Date.now() }); // flush 2 waits too
    release();
    await settle();
    expect(sent.slice(-1)).toEqual([["playback:pause", 9_500, "c"]]);
    expect(sent.filter(([, p]) => p === 9_000)).toEqual([]);
  });
});
