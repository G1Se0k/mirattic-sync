import {
  DEFAULT_DRIFT,
  type DriftThresholds,
  type MediaProviderAdapter,
  type PlaybackCommand,
  type PlaybackState,
  type PlayerSnapshot,
} from "@mirattic/types";
import type { ServerClock } from "./clock";

/** Where the room's playback is now, extrapolated from the last authoritative state. */
export function estimatePosition(state: PlaybackState, serverNow: number) {
  const elapsed = state.playing ? Math.max(0, serverNow - state.capturedAt) : 0;
  const position = state.positionMs + elapsed;
  return state.durationMs === undefined ? position : Math.min(position, state.durationMs);
}

export type DriftAction = "ignore" | "recheck" | "seek" | "immediate";

export function classifyDrift(driftMs: number, t: DriftThresholds = DEFAULT_DRIFT): DriftAction {
  const d = Math.abs(driftMs);
  if (d > t.immediateAboveMs) return "immediate";
  if (d > t.seekAboveMs) return "seek";
  if (d >= t.ignoreBelowMs) return "recheck";
  return "ignore";
}

export type FollowerStatus =
  | { kind: "synced" | "rechecking" | "confirming" | "corrected"; driftMs: number }
  /** Off by `driftMs` on a player we can't seek: the user has to move to `targetMs` themselves. */
  | { kind: "manual"; driftMs: number; targetMs: number }
  | { kind: "waiting" | "ad" | "other-content" };

/**
 * Member side of the host-authoritative room: keeps the local player on the room's playback state.
 *
 * - States with a version <= the current one are dropped (late / reordered messages).
 * - Play state mismatches are fixed at once; position drift follows the drift policy.
 *   A drift in the "seek" band that the member accumulated on its own is confirmed on one recheck
 *   before seeking (it may be a buffering blip); after a host event it is corrected at once.
 * - Our own play/pause/seek fire `onChange` again; the re-check then sees ~0 drift and stops,
 *   so no echo-suppression window is needed while members never publish.
 */
export class SyncFollower {
  private state: PlaybackState | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private confirming = false;
  private running = false;
  /** A check requested while one was running; true if any of them was a host event. */
  private queued: boolean | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly opts: {
      adapter: MediaProviderAdapter;
      clock: ServerClock;
      recheckMs?: number;
      onStatus?: (status: FollowerStatus) => void;
    },
  ) {
    this.unsubscribe = opts.adapter.onChange(() => void this.check(false));
  }

  get version() {
    return this.state?.version ?? -1;
  }

  /** @returns false if the state is stale and was ignored. */
  apply(state: PlaybackState) {
    if (state.version <= this.version) return false;
    this.state = state;
    this.confirming = false;
    void this.check(true);
    return true;
  }

  stop() {
    clearTimeout(this.timer);
    this.unsubscribe();
    this.state = null;
  }

  private async check(hostEvent: boolean) {
    if (this.running) {
      this.queued = this.queued === true || hostEvent;
      return;
    }
    this.running = true;
    try {
      await this.evaluate(hostEvent);
    } finally {
      this.running = false;
    }
    if (this.queued !== null) {
      const queuedHostEvent = this.queued;
      this.queued = null;
      await this.check(queuedHostEvent);
    }
  }

  private async evaluate(hostEvent: boolean) {
    clearTimeout(this.timer);
    const { adapter, clock, onStatus } = this.opts;
    const state = this.state;
    if (!state) return;

    let snap = await adapter.getSnapshot();
    // A newer state arrived meanwhile: its queued check takes over.
    if (this.state !== state) return;
    if (!snap) return onStatus?.({ kind: "waiting" });
    if (snap.adPlaying) {
      this.schedule();
      return onStatus?.({ kind: "ad" });
    }
    if (snap.contentId !== state.contentId) return onStatus?.({ kind: "other-content" });

    if (snap.playing !== state.playing) {
      await (state.playing ? adapter.play() : adapter.pause());
      snap = (await adapter.getSnapshot()) ?? snap;
      if (this.state !== state) return;
    }

    const target = estimatePosition(state, clock.serverNow());
    const driftMs = snap.positionMs - target;
    const action = classifyDrift(driftMs, { ...DEFAULT_DRIFT, ...adapter.driftOverride });

    if (action !== "ignore" && action !== "recheck" && adapter.seekable === false) {
      this.confirming = false;
      if (state.playing) this.schedule(); // keep the target current until the user catches up
      return onStatus?.({ kind: "manual", driftMs, targetMs: target });
    }
    if (action === "immediate" || (action === "seek" && (hostEvent || this.confirming))) {
      this.confirming = false;
      // Re-estimate: play()/getSnapshot() may have taken a while on a real player.
      await adapter.seek(estimatePosition(state, clock.serverNow()));
      this.schedule(); // real players land imprecisely; verify
      return onStatus?.({ kind: "corrected", driftMs });
    }
    if (action === "seek") {
      this.confirming = true;
      this.schedule();
      return onStatus?.({ kind: "confirming", driftMs });
    }
    this.confirming = false;
    // Drift only changes while playing; a paused player is re-checked on the next event.
    if (action === "recheck" && state.playing) this.schedule();
    onStatus?.({ kind: action === "recheck" ? "rechecking" : "synced", driftMs });
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(false), this.opts.recheckMs ?? 1000);
  }
}

export type PlaybackCommandType = "playback:play" | "playback:pause" | "playback:seek";

/**
 * Host side: turns local player changes into playback commands, starting with the current state.
 * Bursts (e.g. play then an immediate seek) are coalesced to at most one command per `minIntervalMs`.
 * A change only marks the state dirty; what goes out is a fresh snapshot read at send time, so it is
 * always the latest state (a dropped last command would leave members permanently off) and never a
 * stale one — from before an ad started, or from the previous video. Nothing is sent during an ad or
 * without a player. `send` gets that snapshot too, so the caller can check which content it is about.
 * `capturedAt` is converted to server time so members can extrapolate.
 * When the video goes away while playing (the host went back, closed the tab), members are paused where it
 * was: `send` then gets `gone = true` with the last sent snapshot, now paused at the extrapolated position.
 */
export function publishHost(
  adapter: MediaProviderAdapter,
  clock: ServerClock,
  /** @returns false if the command was not sent (e.g. the caller skipped it). */
  send: (type: PlaybackCommandType, command: PlaybackCommand, snapshot: PlayerSnapshot, gone?: boolean) => boolean | void,
  minIntervalMs = 200,
) {
  let last: PlayerSnapshot | null = null;
  let dirty = false;
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let flushes = 0;

  const flush = async () => {
    timer = undefined;
    if (!dirty || stopped) return;
    dirty = false;
    lastSentAt = Date.now();
    const id = ++flushes;
    const s = await adapter.getSnapshot();
    // A newer flush started while we waited: it reads a newer state.
    if (stopped || id !== flushes || !s || s.adPlaying) return;
    // Compared with the last *sent* state, so a coalesced play+seek still goes out as a play. A new video
    // restarts the room paused, so its first command always states play or pause.
    const fresh = !last || s.contentId !== last.contentId || s.playing !== last.playing;
    const type = fresh ? (s.playing ? "playback:play" : "playback:pause") : "playback:seek";
    const command = { positionMs: Math.round(s.positionMs), capturedAt: Math.round(clock.toServer(s.capturedAt)) };
    if (send(type, command, s) !== false) last = s;
  };
  const queue = (s: PlayerSnapshot) => {
    if (s.adPlaying) {
      dirty = false; // an ad started before the window closed: nothing to say until it ends
      return;
    }
    dirty = true;
    if (timer !== undefined) return;
    const wait = lastSentAt + minIntervalMs - Date.now();
    if (wait <= 0) void flush();
    else timer = setTimeout(() => void flush(), wait);
  };

  const gone = () => {
    if (stopped || !last?.playing) return;
    clearTimeout(timer);
    timer = undefined;
    dirty = false;
    flushes++; // a flush still reading a snapshot must not send after this
    const now = Date.now();
    const s = { ...last, positionMs: last.positionMs + Math.max(0, now - last.capturedAt), playing: false, capturedAt: now };
    const command = { positionMs: Math.round(s.positionMs), capturedAt: Math.round(clock.toServer(now)) };
    if (send("playback:pause", command, s, true) !== false) last = s;
  };

  void adapter.getSnapshot().then((s) => s && !last && !dirty && queue(s));
  const unsubscribe = adapter.onChange(queue);
  const unsubscribeGone = adapter.onGone?.(gone);
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    unsubscribeGone?.();
  };
}
