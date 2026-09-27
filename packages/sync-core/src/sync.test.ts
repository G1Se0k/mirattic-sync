import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackCommand, PlaybackState } from "@mirattic/types";
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
  it("republishes the current state when restarted after a disconnect", async () => {
    const clock = new ServerClock();
    clock.addSample(Date.now(), Date.now(), Date.now());
    const host = new MockMediaProvider(CONTENT);
    const sent: [string, PlaybackCommand][] = [];
    const stop = publishHost(host, clock, (type, cmd) => sent.push([type, cmd]));
    await settle();
    await host.play();
    await vi.advanceTimersByTimeAsync(200);
    stop(); // socket closed

    await host.seek(42_000);
    await host.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);

    publishHost(host, clock, (type, cmd) => sent.push([type, cmd])); // reconnected
    await settle();
    expect(sent.at(-1)).toEqual(["playback:pause", { positionMs: 42_000, capturedAt: Date.now() }]);
  });
});
