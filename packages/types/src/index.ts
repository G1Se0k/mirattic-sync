// Provider-agnostic types shared by desktop, extension and (by contract) the server.
// All timestamps are UTC epoch milliseconds.

export const MEDIA_PROVIDERS = ["youtube", "netflix", "laftel"] as const;
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

export type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  text: string;
  mediaPositionMs?: number;
  createdAt: number;
};

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
