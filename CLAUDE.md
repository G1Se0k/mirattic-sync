# CLAUDE.md — Mirattic Sync

## Project Summary

Mirattic Sync is a cross-platform social watch-party application for macOS and Windows with a browser extension.

Users can:
- add friends,
- see friends' current viewing presence,
- join a friend's viewing session,
- synchronize playback,
- chat beside the video,
- attach chat/reactions to a playback timestamp.

Initial target platforms:
- YouTube
- Netflix (experimental)
- Laftel (experimental)

The product MUST NOT stream, proxy, download, decrypt, or redistribute video/audio content.
Each user watches content directly from the original provider using their own valid account and entitlement.

---

## Core Architecture

The system is split into three primary components:

1. Desktop App
   - Tauri 2
   - React
   - TypeScript
   - macOS / Windows
   - social UI, friends, presence, rooms, notifications

2. Browser Extension
   - TypeScript
   - Chromium first
   - detects and controls supported web players
   - injects Mirattic side chat panel

3. Backend
   - Java 21
   - Spring Boot
   - Spring Security
   - Spring Data JPA
   - Spring WebSocket
   - MySQL

Shared code should live in packages where practical.

---

## Non-Negotiable Rules

### 1. No media redistribution

Never implement:
- video/audio proxying,
- stream extraction,
- DRM bypass,
- downloading protected media,
- re-hosting content,
- audio-only extraction from video providers,
- region restriction bypass,
- concurrent stream limit bypass.

Mirattic only synchronizes metadata and playback state.

### 2. Never collect streaming-provider credentials

Never store or send to Mirattic backend:
- Netflix passwords,
- Laftel passwords,
- provider cookies,
- provider session tokens,
- browser authentication secrets.

Users authenticate directly with each provider in their own browser.

### 3. Provider isolation

Provider-specific logic must be isolated.

Do not access Netflix / YouTube / Laftel DOM selectors outside their respective adapter modules.

Expected structure:

```text
providers/
  youtube/
  netflix/
  laftel/
```

Core, Room, Presence, Chat and UI code must depend on shared interfaces, not provider internals.

### 4. Policy-first implementation

Before implementing or changing a provider integration:
- verify current official documentation and policies,
- document findings under `docs/platform-policy/`,
- record the verification date,
- mark uncertain behavior explicitly.

Never guess that a provider allows a behavior.

If policy is unclear, prefer the more conservative implementation.

### 5. YouTube UI rule

Do not cover or obstruct the YouTube player with Mirattic UI.
Chat and reactions must appear outside the player area.

### 6. Playback sync does not mean content sharing

Only share:
- provider identifier,
- content identifier / URL when appropriate,
- playback position,
- play/pause state,
- timestamps,
- room events.

Do not share media bytes.

---

## Common Types

Provider-agnostic types should live in a shared package.

Recommended models:

```ts
type MediaProvider = "youtube" | "netflix" | "laftel";

type MediaPresence = {
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

type PlaybackState = {
  provider: MediaProvider;
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
  sourceUserId: string;
  version: number;
};
```

Do not make Spotify/Netflix/YouTube-specific IDs the global primary identifier for the application.

---

## Provider Interface

Provider adapters should follow a common abstraction.

```ts
interface MediaProviderAdapter {
  provider: MediaProvider;

  detect(): boolean;
  getPresence(): Promise<MediaPresence | null>;
  getPlaybackState(): Promise<PlaybackState | null>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  onPlaybackChanged(
    callback: (state: PlaybackState) => void
  ): () => void;

  destroy(): void;
}
```

Extend only when a real use case requires it.
Do not create provider-specific methods in the shared UI.

---

## Sync Rules

MVP uses a host-authoritative room model.

Host events:
- play
- pause
- seek
- content change

are propagated to members.

Playback state must include:
- `positionMs`
- `capturedAt`
- `playing`
- `version`

Estimate live position from `capturedAt` instead of sending position updates every few milliseconds.

Late WebSocket messages must not overwrite newer room state.
Use monotonically increasing `version` values.

Initial drift policy:

```text
< 500ms      ignore
500-1500ms   re-check later
> 1500ms     seek correction
> 3000ms     immediate correction
```

Provider-specific overrides are allowed.

---

## WebSocket Guidelines

Use explicit event names.

Examples:

```text
presence:update
room:join
room:leave
room:invite
playback:update
playback:play
playback:pause
playback:seek
playback:content-change
sync:request
sync:response
chat:message
reaction:add
```

All room events must validate membership server-side.
Do not trust `userId` supplied by clients without authenticated session context.

---

## Privacy Rules

Viewing activity is private by default.

Support visibility levels:
- OFF
- FRIENDS
- ROOM_ONLY

Playback position should normally be more restricted than title-level presence.

Example default behavior:
- friends may see title/provider,
- exact timestamp visible only inside the same room.

Users must be able to:
- disable activity sharing,
- block users,
- leave rooms,
- delete their account/data.

---

## Chat Panel Rules

The browser extension may add a side panel beside the provider page.

Do not overlay provider player controls.

Chat messages may optionally include current playback timestamp.

Example:

```text
Giseok [24:31]
"This looks like foreshadowing."
```

Clicking a timestamp should ASK the user before seeking.
Do not force local playback jumps from old chat history.

---

## Security

Backend minimum requirements:
- password hashing,
- secure auth/session design,
- refresh-token rotation if JWT refresh tokens are used,
- CSRF protection where relevant,
- restrictive CORS,
- WebSocket authentication,
- room authorization,
- friend/presence authorization,
- rate limiting,
- secrets via environment variables,
- no secrets in logs.

Never log:
- passwords,
- access tokens,
- refresh tokens,
- cookies,
- streaming-provider session data.

---

## Development Strategy

Do not build every provider at once.

Required order:

1. Architecture / monorepo
2. Account / friends / presence
3. MockMediaProvider
4. Playback sync engine
5. Browser extension base
6. YouTube adapter
7. Desktop integration
8. Netflix experimental adapter
9. Laftel experimental adapter
10. polish/privacy/deployment

The MockMediaProvider is mandatory.
The sync engine must be testable without Netflix/YouTube/Laftel.

---

## Phase Workflow

At the end of every phase:

1. run relevant tests,
2. verify the app still builds,
3. update `docs/progress.md`,
4. record architecture decisions,
5. list known issues,
6. state the next exact task.

`docs/progress.md` must contain enough information to continue after context compaction.

Before a compact, ensure the current state is written to files rather than existing only in conversation history.

---

## Progress File Format

Use roughly this structure:

```md
# Current Phase
Phase 3 — Extension Base

## Completed
- ...

## Major Files Changed
- ...

## Architecture Decisions
- ...

## Tests
- ...

## Known Issues
- ...

## Next Task
- ...
```

---

## Coding Rules

- Prefer simple, explicit code over premature abstraction.
- Do not rewrite unrelated working code.
- Do not create huge files when responsibilities can be separated clearly.
- Do not introduce a dependency without explaining why it is needed.
- Do not duplicate shared types between Desktop, Extension and Backend clients.
- Keep provider code replaceable.
- Add tests for non-trivial synchronization and authorization logic.
- Avoid unnecessary polling when event-driven state is available.
- All timestamps exchanged over the network use UTC / epoch milliseconds.

---

## Repository Expectations

Recommended layout:

```text
mirattic-sync/
  apps/
    desktop/
    extension/
    web/

  packages/
    types/
    api-client/
    websocket-client/
    media-core/
    ui/

  server/

  docs/
    architecture/
    platform-policy/
    protocol/
    progress.md

  CLAUDE.md
  README.md
```

The `web` app is optional during MVP.
Do not spend time on it until Desktop + Extension + Backend work reliably.

---

## MVP Definition of Done

MVP is complete when:

1. Two users can create accounts and become friends.
2. Presence updates in real time.
3. Desktop app shows a friend's current YouTube viewing state.
4. A user can click "Watch Together".
5. Both users can join the same private room.
6. YouTube playback play/pause/seek is synchronized.
7. Chat appears beside the video.
8. Chat messages can carry a playback timestamp.
9. macOS and Windows desktop builds work.
10. No provider credentials or media bytes pass through Mirattic servers.

Netflix and Laftel are not required for MVP completion.
They are experimental providers added after YouTube is stable.

---

## First Task for Claude Code

Do NOT start implementing immediately.

First:

1. Read `Mirattic_Sync_PLAN.md` and this `CLAUDE.md`.
2. Inspect the repository if it already exists.
3. Identify technical and policy-risk areas.
4. Propose the monorepo structure.
5. Propose backend domain entities.
6. Propose WebSocket protocol.
7. Propose the final `MediaProviderAdapter` interface.
8. Compare Extension → Backend → Desktop communication with a local native bridge approach.
9. Produce a detailed Phase 0-4 implementation plan.
10. Wait for user approval before generating the initial project structure.
