// Provider-agnostic types shared by desktop, extension and (by contract) the server.
// All timestamps are UTC epoch milliseconds.

/** "mock" is the fake player in @mirattic/sync-core, used to develop and test sync without a real provider. */
export const MEDIA_PROVIDERS = ["youtube", "netflix", "laftel", "mock"] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export type MediaPresence = {
  provider: MediaProvider;
  contentId?: string;
  title: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  thumbnailUrl?: string;
  canonicalUrl?: string;
  positionMs?: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
};

/** What a provider adapter reads from the local player. Room layer adds sourceUserId/version. */
export type PlayerSnapshot = {
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
  adPlaying?: boolean;
};

export type PlaybackState = {
  provider: MediaProvider;
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
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

  detect(): boolean;
  getPresence(): Promise<MediaPresence | null>;
  getSnapshot(): Promise<PlayerSnapshot | null>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  onChange(callback: (snapshot: PlayerSnapshot) => void): () => void;
  destroy(): void;
}

export type Visibility = "OFF" | "FRIENDS" | "ROOM_ONLY";

// REST DTOs (mirror server records).
export type UserSummary = { id: string; displayName: string };

/** How a user can sign in. OAuth providers are added here when implemented. */
export type IdentityProvider = "LOCAL";

/**
 * `id` is the user's UID — never an email or provider id. `email` may be absent for OAuth-only users.
 * `friendCode` (8 chars, shown as XXXX-XXXX) is how others add you; only its owner ever sees it.
 */
export type Me = UserSummary & {
  email?: string;
  providers: IdentityProvider[];
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

export type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  text: string;
  mediaPositionMs?: number;
  createdAt: number;
};

/** What a room watches. `contentId` is provider-scoped, never a global id. */
export type RoomContent = {
  provider: MediaProvider;
  contentId: string;
  title: string;
  durationMs?: number;
  canonicalUrl?: string;
};

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Where to watch a content, built from its provider-scoped id — never from a URL another user sent,
 * so a room can't point members at an arbitrary site. undefined = no page to open (mock, unknown id).
 */
export function watchUrl(content: { provider: MediaProvider; contentId: string }): string | undefined {
  if (content.provider === "youtube" && YOUTUBE_VIDEO_ID.test(content.contentId)) {
    return `https://www.youtube.com/watch?v=${content.contentId}`;
  }
  return undefined;
}

export type RoomRole = "HOST" | "MEMBER";

/** `present` = has a live connection that joined the room (`room:join`). */
export type RoomMemberView = { user: UserSummary; role: RoomRole; present: boolean };

export type RoomView = { id: string; content: RoomContent; members: RoomMemberView[]; createdAt: number };

/**
 * Payload of host `playback:play|pause|seek`. `capturedAt` is the host's estimate of *server* time
 * when `positionMs` was read; the server clamps it to the last few seconds.
 */
export type PlaybackCommand = { positionMs: number; capturedAt: number };

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
