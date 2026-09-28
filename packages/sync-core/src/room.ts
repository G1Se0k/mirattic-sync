import {
  openUrl,
  PAUSE_REQUEST_COOLDOWN_MS,
  sameSeries,
  type ClientEvent,
  type MediaProvider,
  type MediaProviderAdapter,
  type PlaybackState,
  type PlayerSnapshot,
  type RoomContent,
  type RoomView,
  type ServerEvent,
} from "@mirattic/types";
import { ServerClock } from "./clock";
import { publishHost, SyncFollower, type FollowerStatus } from "./sync";

export type PauseRequest = { userId: string; name: string; reason: string; at: number };

/** What a room screen shows; the extension sends it from its background to the side panel. */
export type RoomSyncState = {
  roomId: string;
  room: RoomView | null;
  /** Closed, or I'm no longer a member. */
  closed: boolean;
  loadFailed: boolean;
  clockReady: boolean;
  /** This app has a player for the room's provider. */
  canPlay: boolean;
  /** undefined = not read yet: nothing is offered (like "open the video") before we know. */
  snapshot: PlayerSnapshot | null | undefined;
  /**
   * The player has shown something else than the room's video (or nothing) for a while: offer to open it.
   * Not at once — entering the room or following the host to the next episode takes the tab a moment.
   */
  away: boolean;
  sync: FollowerStatus | null;
  lastCorrection: number | null;
  /** Member: the host moved to another video outside the series — ask whether to open it. */
  switched: RoomContent | null;
  /** Member: no pause request before this (epoch ms). */
  pauseCooldownUntil: number;
  /** Host: a member asked to pause; cleared after 30 seconds. */
  pauseRequest: PauseRequest | null;
};

export type RoomSyncDeps = {
  roomId: string;
  meId: string;
  loadRoom(id: string): Promise<RoomView>;
  /** The room is gone for me (the load answered 404). */
  isGone(error: unknown): boolean;
  send(event: ClientEvent): boolean;
  /** The player for a provider here, if any; the same object for the same provider. */
  adapter(provider: MediaProvider): MediaProviderAdapter | undefined;
  nowWatching(): RoomContent | null;
  open(url: string): void;

  onChange(state: RoomSyncState): void;
};

/** A room's state before anything is known. */
export function emptyRoomState(roomId: string): RoomSyncState {
  return {
    roomId, room: null, closed: false, loadFailed: false, clockReady: false, canPlay: false, snapshot: undefined,
    away: false, sync: null, lastCorrection: null, switched: null, pauseCooldownUntil: 0, pauseRequest: null,
  };
}

const CLOCK_SAMPLES = 5;
const AWAY_AFTER_MS = 2_000;
const PAUSE_REQUEST_SHOWN_MS = 30_000;

/**
 * One room's live side, without any UI: joins it, measures the clock, publishes the host's player or keeps
 * a member's player on the room, follows the host to other videos (asking unless it's the same series),
 * and carries pause requests between members and the host.
 */
export class RoomSync {
  state: RoomSyncState;
  private readonly clock = new ServerClock();
  private latest: PlaybackState | null = null;
  private follower: SyncFollower | null = null;
  private stopPublishing: (() => void) | null = null;
  private player: MediaProviderAdapter | undefined;
  private engineKey = "";
  private enginePlayer: MediaProviderAdapter | undefined;
  /** The content the host last announced; set from the room only when its content changes. */
  private announced: RoomContent | null = null;
  /** The content this member was last shown, to tell a series step from a switch. */
  private shown: RoomContent | null = null;
  private switchCheck = 0;
  private connected = false;
  private readonly sentAt = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly poll: ReturnType<typeof setInterval>;
  private loads = 0;
  private disposed = false;
  private awaySince: number | null = null;

  constructor(private readonly deps: RoomSyncDeps) {
    this.state = emptyRoomState(deps.roomId);
    void this.reload();
    this.poll = setInterval(() => void this.readSnapshot(), 1000);
  }

  private get isHost() {
    return this.state.room?.members.some((m) => m.user.id === this.deps.meId && m.role === "HOST") ?? false;
  }

  private set(change: Partial<RoomSyncState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.deps.onChange(this.state);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Loads answer in any order: only the latest started one applies. */
  async reload() {
    const mine = ++this.loads;
    try {
      const room = await this.deps.loadRoom(this.deps.roomId);
      if (mine !== this.loads || this.disposed) return;
      const before = this.state.room?.content;
      this.set({ room, loadFailed: false });
      this.contentChanged(before, room.content);
    } catch (e) {
      if (mine !== this.loads || this.disposed) return;
      if (this.deps.isGone(e)) this.set({ closed: true });
      else this.set({ loadFailed: true });
    }
  }

  /** A local change (mute) wins over loads already in flight. */
  setMuted(muted: boolean) {
    this.loads++;
    if (this.state.room) this.set({ room: { ...this.state.room, muted } });
  }

  private contentChanged(before: RoomContent | undefined, content: RoomContent) {
    const sameVideo = before?.provider === content.provider && before.contentId === content.contentId;
    if (!sameVideo || before?.series !== content.series) this.announced = content;
    if (!sameVideo) {
      this.awaySince = null; // a new video: give the tab its moment again
      this.set({ away: false });
      void this.readSnapshot();
    }
    this.memberFollows(content, sameVideo);
    this.refreshPlayer();
  }

  /**
   * A member whose host moved to another video: the next one of the same series (playlist, show) opens by
   * itself, anything else is asked. Not on entering the room, nor if that video is already open.
   */
  private memberFollows(content: RoomContent, sameVideo: boolean) {
    const before = this.shown;
    this.shown = content;
    if (!before || sameVideo || before.provider === content.provider && before.contentId === content.contentId) return;
    if (this.isHost) return;
    const player = this.deps.adapter(content.provider);
    const url = openUrl(content);
    if (!player || !url) return;
    const mine = ++this.switchCheck; // the room may move on again before the tab answers
    void player.getSnapshot().then((s) => {
      if (mine !== this.switchCheck || this.disposed || s?.contentId === content.contentId) return;
      if (sameSeries(before, content)) this.deps.open(url);
      else this.set({ switched: content });
    });
  }

  /** The platform's players changed (a provider turned on or off) or the room's provider did. */
  refreshPlayer() {
    const provider = this.state.room?.content.provider;
    const player = provider ? this.deps.adapter(provider) : undefined;
    if (player !== this.player) {
      this.player = player;
      this.set({ canPlay: !!player, snapshot: player ? undefined : null });
      void this.readSnapshot();
    }
    this.restart();
  }

  /**
   * What the host watches got new details for the same video (a title read later, a playlist joined): the
   * room is told at once, without waiting for a playback event. The server keeps the playback as it is.
   */
  watchingChanged() {
    const now = this.deps.nowWatching();
    const announced = this.announced;
    if (!this.isHost || !this.connected || !now || !announced) return;
    if (now.provider !== announced.provider || now.contentId !== announced.contentId) return; // a new video: the publisher's
    if (now.title === announced.title && now.series === announced.series) return;
    this.deps.send({ type: "playback:content-change", roomId: this.deps.roomId, payload: now });
    this.announced = now;
  }

  /** Socket up or down. The server forgets joins on disconnect: rejoin and re-measure on every connect. */
  setConnected(open: boolean) {
    this.connected = open;
    if (open) {
      this.deps.send({ type: "room:join", roomId: this.deps.roomId, payload: {} });
      for (let i = 0; i < CLOCK_SAMPLES; i++) {
        this.later(() => {
          const reqId = `clock-${Date.now()}-${i}`;
          this.sentAt.set(reqId, Date.now());
          this.deps.send({ type: "sync:request", reqId, payload: null });
        }, i * 200);
      }
    }
    this.restart();
    if (open) this.watchingChanged(); // details that arrived while disconnected (a title read meanwhile)
  }

  handle(event: ServerEvent) {
    if (event.type === "sync:response") {
      const reqId = (event.payload as { reqId: string }).reqId;
      const at = this.sentAt.get(reqId);
      if (at === undefined) return;
      this.sentAt.delete(reqId);
      this.clock.addSample(at, event.serverTime);
      if (!this.state.clockReady) {
        this.set({ clockReady: true });
        this.restart();
      }
      return;
    }
    if (event.roomId !== this.deps.roomId) return;
    if (event.type === "room:update") {
      // Muted from another app of mine: applied before the refetch returns.
      const muted = (event.payload as { muted?: unknown } | null)?.muted;
      if (typeof muted === "boolean") this.setMuted(muted);
      void this.reload();
    }
    if (event.type === "playback:update") {
      const state = event.payload as PlaybackState;
      if (state.version > (this.latest?.version ?? -1)) this.latest = state;
      this.follower?.apply(state);
    }
    if (event.type === "pause:request" && this.isHost && event.userId) {
      const name = this.state.room?.members.find((m) => m.user.id === event.userId)?.user.displayName ?? "멤버";
      const request = { userId: event.userId, name, reason: (event.payload as { reason?: string }).reason ?? "", at: Date.now() };
      this.set({ pauseRequest: request });
      this.later(() => this.state.pauseRequest === request && this.set({ pauseRequest: null }), PAUSE_REQUEST_SHOWN_MS);
    }
  }

  /** Starts the host's publisher or the member's follower for the current player, role and connection. */
  private restart() {
    const ready = !!this.player && !!this.state.room && this.state.clockReady;
    const host = this.isHost;
    const key = !ready ? "" : host ? (this.connected ? "host" : "") : "member";
    const engineOf = this.player;
    if (key === this.engineKey && engineOf === this.enginePlayer) return;
    this.stopEngines();
    this.engineKey = key;
    this.enginePlayer = engineOf;
    if (!key || !engineOf) return;
    if (key === "host") {
      this.stopPublishing = publishHost(engineOf, this.clock, (type, payload, snapshot, gone) => {
        const roomId = this.deps.roomId;
        // The video went away: pause the members on the content they are following, never on a new one.
        if (gone) return snapshot.contentId === this.announced?.contentId && this.deps.send({ type, roomId, payload });
        // The command is about `snapshot`'s video. Its metadata arrives with the change; until then, skip —
        // that change triggers another send.
        const now = this.deps.nowWatching();
        if (!now || now.contentId !== snapshot.contentId) return false;
        // Also the same video joining a playlist (series): the server then keeps the playback as it is.
        if (now.contentId !== this.announced?.contentId || now.series !== this.announced?.series) {
          this.deps.send({ type: "playback:content-change", roomId, payload: now });
          this.announced = now;
        }
        return this.deps.send({ type, roomId, payload });
      });
      return;
    }
    const follower = new SyncFollower({
      adapter: engineOf,
      clock: this.clock,
      onStatus: (s) => this.set(s.kind === "corrected" ? { sync: s, lastCorrection: Math.round(s.driftMs) } : { sync: s }),
    });
    this.follower = follower;
    if (this.latest) follower.apply(this.latest);
  }

  private stopEngines() {
    this.follower?.stop();
    this.follower = null;
    this.stopPublishing?.();
    this.stopPublishing = null;
  }

  private async readSnapshot() {
    const player = this.player;
    if (!player) return;
    const snapshot = await player.getSnapshot();
    if (player !== this.player || this.disposed) return;
    const content = this.state.room?.content;
    const off = !snapshot || !content || snapshot.contentId !== content.contentId;
    const now = Date.now();
    this.awaySince = off ? (this.awaySince ?? now) : null;
    const away = off && now - this.awaySince! >= AWAY_AFTER_MS;
    if (away !== this.state.away) this.set({ away });
    const old = this.state.snapshot;
    // Unchanged within a second of playback: no update (the side panel would re-render for nothing).
    if (old && snapshot && old.contentId === snapshot.contentId && old.playing === snapshot.playing
      && old.adPlaying === snapshot.adPlaying && Math.abs(old.positionMs - snapshot.positionMs) < 500 && !snapshot.playing) return;
    this.set({ snapshot });
  }

  /** Member: asks the host to pause (the "일시정지 요청" button), at most once per 30 seconds. */
  requestPause(reason = "") {
    if (this.isHost || Date.now() < this.state.pauseCooldownUntil) return;
    if (this.deps.send({ type: "pause:request", roomId: this.deps.roomId, payload: { reason: reason.trim().slice(0, 200) } })) {
      const until = Date.now() + PAUSE_REQUEST_COOLDOWN_MS;
      this.set({ pauseCooldownUntil: until });
      // A screen shows the button again when the cooldown ends, even with nothing else changing meanwhile.
      this.later(() => this.state.pauseCooldownUntil === until && this.set({ pauseCooldownUntil: until }), PAUSE_REQUEST_COOLDOWN_MS);
    }
  }

  dismissPauseRequest() {
    this.set({ pauseRequest: null });
  }

  /** Host: pause for everyone (the host's own player; the publisher tells the room). */
  pauseAll() {
    this.set({ pauseRequest: null });
    if (this.isHost) void this.player?.pause();
  }

  /** Host: jump everyone to a chat timestamp. */
  seek(positionMs: number) {
    if (this.isHost && this.player && this.player.seekable !== false) void this.player.seek(positionMs);
  }

  openSwitched() {
    const url = this.state.switched && openUrl(this.state.switched);
    if (url) this.deps.open(url);
    this.set({ switched: null });
  }

  dismissSwitched() {
    this.set({ switched: null });
  }

  /** Leaves the room live (the membership stays). */
  dispose() {
    if (this.disposed) return;
    this.stopEngines();
    clearInterval(this.poll);
    this.timers.forEach(clearTimeout);
    if (this.connected) this.deps.send({ type: "room:leave", roomId: this.deps.roomId, payload: {} });
    this.disposed = true;
  }
}
