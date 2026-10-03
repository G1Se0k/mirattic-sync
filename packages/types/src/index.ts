// Provider-agnostic types shared by the extension's parts and (by contract) the server.
// All timestamps are UTC epoch milliseconds.

/** "mock" is the fake player in @mirattic/sync-core, used to develop and test sync without a real provider. */
export const MEDIA_PROVIDERS = ["youtube", "netflix", "laftel", "mock"] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export type MediaPresence = {
  provider: MediaProvider;
  contentId?: string;
  /** Netflix: the show or film's own title, with `season` / `episode` / `episodeTitle` apart (see `contentTitle`). */
  title: string;
  /** YouTube: the channel, as its watch page shows it. */
  channel?: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  thumbnailUrl?: string;
  canonicalUrl?: string;
  /** Same value = same series (YouTube playlist, Laftel item, a Netflix run of episodes). */
  series?: string;
  positionMs?: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
};

/** What I watch, in the parts my own status lines show apart (the room title joins them: `contentTitle`). */
export type WatchingInfo = Pick<MediaPresence, "provider" | "title" | "channel" | "season" | "episode">;

/** What a provider adapter reads from the local player. Room layer adds sourceUserId/version. */
export type PlayerSnapshot = {
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
  /** Playback speed (1 = normal); absent where the player can't tell. */
  rate?: number;
  capturedAt: number;
  adPlaying?: boolean;
  /** The user is holding the page's seek bar (decision 86); absent where the page can't tell. */
  scrubbing?: boolean;
};

export type PlaybackState = {
  provider: MediaProvider;
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
  /** The host's playback speed (1 = normal): members play at it, positions advance at it. */
  rate?: number;
  capturedAt: number;
  sourceUserId: string;
  version: number;
};

export type DriftThresholds = {
  ignoreBelowMs: number;
  seekAboveMs: number;
  immediateAboveMs: number;
};

export const DEFAULT_DRIFT: DriftThresholds = {
  ignoreBelowMs: 500,
  seekAboveMs: 1500,
  immediateAboveMs: 3000,
};

export interface MediaProviderAdapter {
  provider: MediaProvider;
  driftOverride?: Partial<DriftThresholds>;
  /** false: the provider can't be seeked from outside (Netflix); the member is told where to go instead. */
  seekable?: boolean;

  detect(): boolean;
  getPresence(): Promise<MediaPresence | null>;
  getSnapshot(): Promise<PlayerSnapshot | null>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  /** Plays at `rate` (1 = normal). Optional: without it the room's speed isn't followed. */
  setRate?(rate: number): Promise<void>;

  onChange(callback: (snapshot: PlayerSnapshot) => void): () => void;
  /** The video went away (left the watch page, tab closed). Optional: the mock player never goes. */
  onGone?(callback: () => void): () => void;
  /**
   * A member following the room's `contentId`: at the end of that episode, stay on the credits instead of letting
   * the site move on to the next one by itself (the host decides). null = off. Only where a site does that (Netflix).
   */
  keepCredits?(contentId: string | null): void;
  destroy(): void;
}

export type Visibility = "OFF" | "FRIENDS" | "ROOM_ONLY";

// REST DTOs (mirror server records).
export type UserSummary = { id: string; displayName: string };

/**
 * `id` is the Mirattic UID — never an email. `email` is the Mirattic account's, read live from Mirattic Auth
 * (absent if Auth couldn't be reached). `friendCode` (8 chars, shown as XXXX-XXXX) is how others add you; only its
 * owner ever sees it.
 */
export type Me = UserSummary & {
  email?: string;
  friendCode: string;
  presenceVisibility: Visibility;
  positionVisibility: Visibility;
};

export type AuthTokens = { accessToken: string; refreshToken: string; user: UserSummary };

export type PresenceStatus = "OFFLINE" | "ONLINE" | "WATCHING";

/** A friend's presence as the server lets you see it. `media` is absent when hidden or not watching. */
export type PresenceView = { status: PresenceStatus; media?: MediaPresence };

export type FriendView = { user: UserSummary; presence: PresenceView };

export type FriendRequestView = { id: string; user: UserSummary; createdAt: number };

export type FriendRequests = { incoming: FriendRequestView[]; outgoing: FriendRequestView[] };

/**
 * A room log line (decision 78), shown centered: someone came in / went out (`text` = their name then), or the
 * host played / paused / moved / changed the video (`text` = its title), removed a member or handed the room over
 * (`kick` / `host`, `text` = that member's name, decision 79), or a member stamped a time (`stamp`, `text` = their
 * name, decision 102). Sent as `chat:log`.
 */
export type ChatLogKind = "join" | "leave" | "play" | "pause" | "seek" | "content" | "kick" | "host" | "stamp";

/** A chat line someone wrote (`chat:message`), or a room log (`kind`, `chat:log`). */
export type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  text: string;
  mediaPositionMs?: number;
  kind?: ChatLogKind | null;
  /** The video `mediaPositionMs` belongs to (`contentKey` of the room's then; never shown, decision 102). */
  contentKey?: string;
  createdAt: number;
  /** Deleted for everyone: `text` is empty, shown as a placeholder. */
  deleted?: boolean;
};

/** `pause:request` (member → host): at most one per member and room every 30 seconds. */
export const PAUSE_REQUEST_COOLDOWN_MS = 30_000;

/** `chat:delete`: one message (`id`), or every message of a deleted account (`userId`). */
export type ChatDeleted = { id?: string; userId?: string };

export const REPORT_REASONS = { SPAM: "스팸", HARASSMENT: "괴롭힘·욕설", INAPPROPRIATE: "부적절한 내용", OTHER: "기타" } as const;
export type ReportReason = keyof typeof REPORT_REASONS;
/** Exactly one of `userId` / `messageId`. */
export type ReportTarget = { userId: string } | { messageId: string };

/** What a room watches. `contentId` is provider-scoped, never a global id. */
export type RoomContent = {
  provider: MediaProvider;
  contentId: string;
  title: string;
  durationMs?: number;
  canonicalUrl?: string;
  /** See `MediaPresence.series`. */
  series?: string;
  /** Who made it (YouTube's channel): sent with a change for its chat line ("<channel> - <title>"); rooms don't keep it. */
  channel?: string;
};

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const NETFLIX_ID = /^\d{1,12}$/;
/** Laftel: "<item id>/<episode id>", both parts of its player URL. */
const LAFTEL_ID = /^\d{1,10}\/\d{1,10}$/;

/**
 * Where to watch a content, built from its provider-scoped id — never from a URL another user sent,
 * so a room can't point members at an arbitrary site. undefined = no page to open (mock, unknown id).
 */
export function watchUrl(content: { provider: MediaProvider; contentId: string }): string | undefined {
  if (content.provider === "youtube" && YOUTUBE_VIDEO_ID.test(content.contentId)) {
    return `https://www.youtube.com/watch?v=${content.contentId}`;
  }
  if (content.provider === "netflix" && NETFLIX_ID.test(content.contentId)) {
    return `https://www.netflix.com/watch/${content.contentId}`;
  }
  if (content.provider === "laftel" && LAFTEL_ID.test(content.contentId)) {
    return `https://laftel.net/player/${content.contentId}`;
  }
  return undefined;
}

/** The host moved on within the same series: members follow without being asked. */
export function sameSeries(a: RoomContent | undefined, b: RoomContent | undefined) {
  return !!a?.series && a.provider === b?.provider && a.series === b.series;
}

/** What a chat line's position belongs to: "<provider>:<contentId>", as the server writes it (decision 102). */
export function contentKey(content: { provider: MediaProvider; contentId: string }) {
  return `${content.provider}:${content.contentId}`;
}

export type RoomRole = "HOST" | "MEMBER";

/** `present` = has a live connection that joined the room (`room:join`). */
export type RoomMemberView = { user: UserSummary; role: RoomRole; present: boolean };

/** `unread` (others' messages since I last had the room open) and `muted` are mine: 0 / false in an invite. */
export type RoomView = {
  id: string;
  /** null: no video yet (decision 92) — the host's first one becomes it. */
  content: RoomContent | null;
  members: RoomMemberView[];
  createdAt: number;
  unread: number;
  muted: boolean;
  /** Join code (decision 77); absent for rooms made before codes. */
  code?: string;
  /** An invitation's time left (invitation lists and `room:invite`, decision 87). */
  expiresInMs?: number;
  /** The room's type (decision 93): the site the host picked, or its video's; null/absent without one. */
  type?: MediaProvider | null;
  /** Rises with each type change; `typeSeen` is mine — while lower, a member (not the host) is asked about it. */
  typeVersion?: number;
  typeSeen?: number;
};

/** A friend's watch request to me (`watch:request`, incoming list), with its time left (decision 87). */
export type IncomingRequest = UserSummary & { expiresInMs?: number };
export const PROVIDER_NAMES: Record<MediaProvider, string> = { youtube: "YouTube", netflix: "Netflix", laftel: "Laftel", mock: "Mock" };

/** How long an invitation or a watch request counts (decision 87): the server's, assumed when not sent. */
export const INCOMING_MS = 30_000;

/**
 * Payload of host `playback:play|pause|seek`. `capturedAt` is the host's estimate of *server* time
 * when `positionMs` was read; the server clamps it to the last few seconds.
 */
/** `scrubbing`: the host holds the seek bar, so a pause may be the start of a drag (decision 86). */
/** `rate`: the host's playback speed (1 = normal); absent is normal. */
export type PlaybackCommand = { positionMs: number; capturedAt: number; scrubbing?: boolean; rate?: number };

// WebSocket envelopes. Clients never send userId; the server stamps it from the authenticated session.
export type ClientEvent<T = unknown> = {
  type: string;
  reqId?: string;
  roomId?: string;
  payload: T;
};

export type ServerEvent<T = unknown> = {
  type: string;
  roomId?: string;
  userId?: string;
  version?: number;
  serverTime: number;
  payload: T;
};

/** "Title 시즌 2 3화 · Name": a presence's full title, as a room's content title. */
export function contentTitle(p: Pick<MediaPresence, "title" | "season" | "episode" | "episodeTitle">) {
  return `${p.title}${episodeLabel(p) ? ` ${episodeLabel(p)}` : ""}${p.episodeTitle ? ` · ${p.episodeTitle}` : ""}`.slice(0, 300);
}

/** "3화", or "시즌 2 3화" past the first season; "" without an episode number. */
export function episodeLabel(p: Pick<MediaPresence, "season" | "episode">) {
  if (p.episode === undefined) return "";
  return p.season !== undefined && p.season > 1 ? `시즌 ${p.season} ${p.episode}화` : `${p.episode}화`;
}

/**
 * The room I host to invite a friend into: the one showing what I watch now (the open one first). When I
 * watch nothing, any room I host. undefined = start a new room.
 */
export function roomToInvite(rooms: RoomView[], meId: string, openRoom: string | null, watching: RoomContent | null) {
  return [...rooms]
    .sort((a, b) => Number(b.id === openRoom) - Number(a.id === openRoom))
    .find(
      (r) =>
        r.members.some((m) => m.user.id === meId && m.role === "HOST") &&
        // (a room without a video yet takes what I watch)
        (!watching || !r.content || (r.content.provider === watching.provider && r.content.contentId === watching.contentId)),
    );
}
