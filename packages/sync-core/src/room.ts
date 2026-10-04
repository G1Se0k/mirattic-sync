import {
  watchUrl,
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
  /** That player's site (the host's: what they watch now): with `snapshot`, which video the browser shows. */
  playerProvider: MediaProvider | null;
  /** undefined = not read yet: nothing is offered (like "open the video") before we know. */
  snapshot: PlayerSnapshot | null | undefined;
  /**
   * The player has shown something else than the room's video (or nothing) for a while: offer to open it.
   * Not at once — entering the room or following the host to the next episode takes the tab a moment.
   */
  away: boolean;
  sync: FollowerStatus | null;
  /** Member: the host moved to another video outside the series — ask whether to open it. */
  switched: RoomContent | null;
  /** Member: no pause request before this (epoch ms). */
  pauseCooldownUntil: number;
  /** Host: a member asked to pause; cleared after 30 seconds. */
  pauseRequest: PauseRequest | null;
  /** Whether the host's browser shows the room's video (`room:host-video`); null = not known (not told). */
  hostVideo: boolean | null;
};

/**
 * This browser shows the room's video (the followed tab is on it, same site and id): a time can be stamped there, and
 * the host's click on one moves the room. Not with no tab, a tab with no video, or another one.
 */
export function showsRoomVideo(s: Pick<RoomSyncState, "canPlay" | "playerProvider" | "snapshot">, content: RoomContent | null | undefined) {
  return s.canPlay && !!content && s.playerProvider === content.provider && s.snapshot?.contentId === content.contentId;
}

/** Entering a room with no snapshot yet: how long a tab still connecting gets before the video is opened. */
const ENTER_RECHECK_MS = 1500;

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
  /** `quiet`: following the host by itself — the tab moves on in the background, not brought forward. */
  open(url: string, newTab?: boolean, quiet?: boolean): void;
  /** Entered by the user now (not restored): a member without the room's video open gets it in a new tab. */
  openOnEnter?: boolean;
  /** A site's first page (decision 93): where a member goes for a room type whose video isn't of that site yet. */
  siteUrl?(provider: MediaProvider): string | undefined;
  /** The user's setting: false = follow the host to any video without asking (decision 81). Default: ask. */
  askOnSwitch?(): boolean;

  onChange(state: RoomSyncState): void;
};

/** A room's state before anything is known. */
export function emptyRoomState(roomId: string): RoomSyncState {
  return {
    roomId, room: null, closed: false, loadFailed: false, clockReady: false, canPlay: false, playerProvider: null, snapshot: undefined,
    away: false, sync: null, switched: null, pauseCooldownUntil: 0, pauseRequest: null, hostVideo: null,
  };
}

const CLOCK_SAMPLES = 5;
const AWAY_AFTER_MS = 2_000;
export const PAUSE_REQUEST_SHOWN_MS = 30_000;

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
  /** A type change this member just confirmed (its version), until a room load says so (the move happens then). */
  private confirming: number | null = null;

  /** The member confirmed the room's type change up to `version` (decision 93): their tab moves once the room says so. */
  confirmType(version: number) {
    this.confirming = Math.max(this.confirming ?? 0, version);
    void this.reload();
  }
  /** The content the host last announced; set from the room only when its content changes. */
  private announced: RoomContent | null = null;
  /** The content this member was last shown, to tell a series step from a switch. */
  private shown: RoomContent | null = null;
  private switchCheck = 0;
  /** "이 방에서 항상 허용" was ticked: this room's switches open without asking (until it is left). */
  private followAlways = false;
  private connected = false;
  /** Host: what this app last told the room of `showsRoomVideo` (undefined: nothing since joining). */
  private toldHostVideo: boolean | undefined;
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

  /**
   * The member confirmed the room's type change (decision 93): their tab moves there, in place — to the room's video
   * if it is of that site by now, else the site's first page.
   */
  private followConfirmed() {
    const r = this.state.room;
    if (this.isHost || !r?.type) return;
    this.switchCheck++; // anything else under way gives up
    const url = r.content?.provider === r.type ? watchUrl(r.content) : this.deps.siteUrl?.(r.type);
    if (url) this.deps.open(url);
  }

  /** A member who hasn't confirmed the room's latest type change (decision 93). */
  private typePending() {
    const r = this.state.room;
    return !this.isHost && !!r?.type && (r.typeVersion ?? 0) > (r.typeSeen ?? 0);
  }

  private get isHost() {
    return this.state.room?.members.some((m) => m.user.id === this.deps.meId && m.role === "HOST") ?? false;
  }

  private set(change: Partial<RoomSyncState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.tellHostVideo();
    this.deps.onChange(this.state);
  }

  /** Host: the room hears whether this browser shows its video, when that changes (members stamp only while it does). */
  private tellHostVideo() {
    if (!this.isHost || !this.connected) {
      this.toldHostVideo = undefined; // a host again (hand-over, reconnect) tells it afresh
      return;
    }
    const watching = showsRoomVideo(this.state, this.state.room?.content);
    if (watching === this.toldHostVideo) return;
    if (this.deps.send({ type: "room:host-video", roomId: this.deps.roomId, payload: { watching } })) this.toldHostVideo = watching;
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
      // An unconfirmed type change (decision 93): a follow still under way (a tab lookup) gives up, a prompt goes.
      if (this.typePending()) {
        this.switchCheck++;
        if (this.state.switched) this.set({ switched: null });
      }
      // Confirmed here (`confirmType`) and the room says so now: the one move for it is to the room's site (below), not
      // also a follow of its video.
      const confirmed = this.confirming !== null && !this.typePending() && (room.typeSeen ?? 0) >= this.confirming;
      if (confirmed) this.confirming = null;
      this.contentChanged(before, room.content, confirmed);
      if (confirmed) this.followConfirmed();
    } catch (e) {
      if (mine !== this.loads || this.disposed) return;
      if (this.deps.isGone(e)) this.set({ closed: true });
      else this.set({ loadFailed: true });
    }
  }

  private contentChanged(before: RoomContent | null | undefined, content: RoomContent | null, confirmed = false) {
    // Another video (or none): a prompt to follow an earlier one is over.
    if (this.state.switched && (this.state.switched.provider !== content?.provider || this.state.switched.contentId !== content.contentId)) {
      this.set({ switched: null });
    }
    if (!content) {
      // No video yet (decision 92): the host's first one becomes it (the publisher sends it, `announced` unset).
      // Nothing shown to a member yet (`shown` stays unset): its first video opens as on entering only if this
      // sync entered the room (decision 83 — a restored one opens nothing by itself).
      this.announced = null;
      this.refreshPlayer();
      return;
    }
    const sameVideo = before?.provider === content.provider && before.contentId === content.contentId;
    if (!sameVideo || before?.series !== content.series) this.announced = content;
    if (!sameVideo) {
      this.awaySince = null; // a new video: give the tab its moment again
      this.set({ away: false });
      void this.readSnapshot();
    }
    if (confirmed) this.shown = content; // followConfirmed moves the tab
    else this.memberFollows(content, sameVideo);
    this.refreshPlayer();
    // Same player, another room video (the next episode): stay on the credits of that one now.
    if (!sameVideo && this.engineKey === "member") this.enginePlayer?.keepCredits?.(content.contentId);
  }

  /**
   * A member whose host moved to another video: the next one of the same series (playlist, show) opens by
   * itself, anything else is asked. On entering the room (`openOnEnter`), it opens in a new tab, so the video
   * the member was on stays. Never if that video is already open.
   */
  private memberFollows(content: RoomContent, sameVideo: boolean) {
    const before = this.shown;
    this.shown = content;
    // The room's type changed and this member hasn't confirmed it yet (decision 93): no video of the room is followed,
    // opened or asked about meanwhile (whatever came before) — their confirmation moves their tab.
    if (this.typePending()) return;
    const entering = !before && !!this.deps.openOnEnter;
    if (!before && !entering || sameVideo || before?.provider === content.provider && before.contentId === content.contentId) return;
    if (this.isHost) return;
    if (!before) {
      // Entering a room whose type moved on from its video (decision 93): to the type's site, not the old video
      // (whether or not the old video's site can be played here).
      const type = this.state.room?.type;
      const site = type && type !== content.provider ? this.deps.siteUrl?.(type) : undefined;
      if (site) {
        this.switchCheck++;
        return this.deps.open(site, true);
      }
    }
    const player = this.deps.adapter(content.provider);
    const url = watchUrl(content);
    if (!player || !url) return;
    const mine = ++this.switchCheck; // the room may move on again before the tab answers
    if (!before) return this.openOnEnter(content, url, player, mine, 0);
    void player.getSnapshot().then((s) => {
      if (mine !== this.switchCheck || this.disposed || this.typePending() || s?.contentId === content.contentId) return;
      // The same series, the setting, or "이 방에서 항상 허용" (decision 81): opened without asking.
      if (sameSeries(before, content) || this.followAlways || this.deps.askOnSwitch?.() === false) this.deps.open(url, false, true);
      else this.set({ switched: content });
    });
  }

  /**
   * Entering: open the room's video unless it is already what this browser shows. No snapshot yet may just be
   * a tab not connected yet, so that is asked once more after a moment.
   */
  private openOnEnter(content: RoomContent, url: string, player: MediaProviderAdapter, mine: number, tries: number) {
    // The snapshot is this provider's player; what the browser shows can be any provider.
    const watchingIt = () => {
      const w = this.deps.nowWatching();
      return w?.provider === content.provider && w.contentId === content.contentId;
    };
    // Still this room video, and still a member (a wait may see the room move on or me become the host).
    const stillFollowing = () => {
      const now = this.state.room?.content;
      return mine === this.switchCheck && !this.disposed && !this.isHost && !this.typePending()
        && now?.provider === content.provider && now.contentId === content.contentId;
    };
    if (watchingIt()) return;
    void player.getSnapshot().then((s) => {
      if (!stillFollowing() || s?.contentId === content.contentId || watchingIt()) return;
      if (s === null && tries === 0) return this.later(() => this.openOnEnter(content, url, player, mine, 1), ENTER_RECHECK_MS);
      this.deps.open(url, true);
    });
  }

  /**
   * The platform's players changed (a provider turned on or off, the followed tab moved to another site) or the
   * room's provider did. The host's player is the site of what they watch now, whatever the room's video was
   * (decision 92: rooms aren't per site — the publisher then moves the room to it); a member's, the room's.
   */
  refreshPlayer() {
    const roomProvider = this.state.room?.content?.provider;
    const provider = this.isHost ? (this.deps.nowWatching()?.provider ?? roomProvider) : roomProvider;
    const player = provider ? this.deps.adapter(provider) : undefined;
    if (player !== this.player) {
      this.player = player;
      this.set({ canPlay: !!player, playerProvider: player?.provider ?? null, snapshot: player ? undefined : null });
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
    if (now.title === announced.title && now.series === announced.series && now.channel === announced.channel) return;
    this.deps.send({ type: "playback:content-change", roomId: this.deps.roomId, payload: now });
    this.announced = now;
  }

  /** Socket up or down. The server forgets joins on disconnect: rejoin and re-measure on every connect. */
  setConnected(open: boolean) {
    // Heard again on joining, if the host told it; told again by a host (before `connected`: nothing sent yet).
    this.connected = false;
    this.toldHostVideo = undefined;
    if (this.state.hostVideo !== null) this.set({ hostVideo: null });
    this.connected = open;
    if (open) {
      this.deps.send({ type: "room:join", roomId: this.deps.roomId, payload: {} });
      this.tellHostVideo();
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
      void this.reload();
    }
    if (event.type === "room:host-video") {
      const watching = (event.payload as { watching?: unknown } | null)?.watching;
      this.set({ hostVideo: typeof watching === "boolean" ? watching : null });
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
    // A member who hasn't confirmed the room's type change (decision 93) isn't synced meanwhile (their player isn't
    // played, paused or moved by the room until they confirm; the room reloads then and this starts it).
    const key = !ready ? "" : host ? (this.connected ? "host" : "") : this.typePending() ? "" : "member";
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
        if (gone) {
          return engineOf.provider === this.announced?.provider && snapshot.contentId === this.announced.contentId
            && this.deps.send({ type, roomId, payload });
        }
        // The command is about `snapshot`'s video. Its metadata arrives with the change; until then, skip —
        // that change triggers another send.
        const now = this.deps.nowWatching();
        if (!now || now.provider !== engineOf.provider || now.contentId !== snapshot.contentId) return false;
        // Also the same video joining a playlist (series): the server then keeps the playback as it is. Another site
        // with the same id is another video (decision 92: the room follows the host across sites).
        if (now.provider !== this.announced?.provider || now.contentId !== this.announced?.contentId
          || now.series !== this.announced?.series) {
          this.deps.send({ type: "playback:content-change", roomId, payload: now });
          this.announced = now;
        }
        return this.deps.send({ type, roomId, payload });
      });
      return;
    }
    engineOf.keepCredits?.(this.state.room!.content?.contentId ?? null); // a member stays on the credits; the host moves on
    const follower = new SyncFollower({
      adapter: engineOf,
      clock: this.clock,
      onStatus: (s) => this.set({ sync: s }),
    });
    this.follower = follower;
    if (this.latest) follower.apply(this.latest);
  }

  private stopEngines() {
    this.enginePlayer?.keepCredits?.(null);
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

  /** `always`: "이 방에서 항상 허용" — the host's next videos in this room open without asking. */
  openSwitched(always = false) {
    if (always) this.followAlways = true;
    const url = this.state.switched && watchUrl(this.state.switched);
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
