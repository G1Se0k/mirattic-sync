# CLAUDE.md — Mirattic Sync

## Project

Mirattic Sync is a social watch-party Chromium browser extension (no desktop app, decision 88).

Core features:
- friends / presence
- private watch rooms
- synchronized playback
- side chat / room logs (reactions removed, decision 78)
- timestamped chat

Initial providers:
- YouTube
- Netflix (experimental)
- Laftel (experimental)

## Communication

- Always communicate with the user in Korean.
- Use Korean for progress, questions, summaries, validation results, and phase-completion reports.
- When using Codex for validation/review, use the **Sol** model.
- If Codex usage/quota is exhausted, Claude must run the required tests and review directly.
- Codex unavailability is never PASS.

## Mandatory Rules

- Never proxy, download, decrypt, re-host, or redistribute media.
- Never bypass DRM, region restrictions, or concurrent-stream limits.
- Never collect provider passwords, cookies, session tokens, or browser auth secrets.
- Users authenticate directly with providers in their own browser.
- Keep provider-specific code isolated.
- Verify current official provider policies before changing integrations.
- If policy is unclear, choose the conservative implementation.

## Core Architecture

- Extension: WXT + TypeScript, Chromium first
- Backend: Java 21 + Spring Boot + Spring Security + JPA + Raw WebSocket + MySQL
- Shared code: pnpm workspace packages

## Canonical Project Docs

Read these files as the source of truth:

- Architecture decisions: `docs/architecture/plan.md`
- Current progress / phase: `docs/progress.md`
- REST protocol: `docs/protocol/rest.md`
- WebSocket protocol: `docs/protocol/websocket.md`
- Platform-policy process: `docs/platform-policy/README.md`
- Repository overview: `docs/README.md`

## Claude Modules

Read only the relevant module for the current task:

- `docs/claude/architecture.md`
- `docs/claude/media-sync.md`
- `docs/claude/security-policy.md`
- `docs/claude/validation.md`
- `docs/claude/workflow.md`

## Phase Workflow

At the end of every phase:

1. use Codex Sol to validate relevant tests/checks,
2. if Codex quota is exhausted, Claude performs the same validation directly,
3. update `docs/progress.md`,
4. update architecture/protocol docs if decisions changed,
5. record known issues,
6. state the next exact task in Korean.

Before compacting context, write important state to files.

## Development Rule

Do not re-decide an approved architecture choice without a concrete reason.
Existing approved decisions in `docs/architecture/plan.md` take precedence over generic suggestions.

Before implementation:
1. read this file,
2. read `docs/progress.md`,
3. read the relevant canonical/module docs,
4. inspect the repository,
5. implement incrementally.
