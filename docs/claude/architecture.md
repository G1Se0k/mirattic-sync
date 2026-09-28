# Architecture Module

Use `docs/architecture/plan.md` as the authoritative record of approved architecture decisions.

Important current direction:
- pnpm workspace, no Turborepo
- WXT extension
- Chrome sidePanel for chat UI
- Raw WebSocket + JSON envelope
- JWT access + DB refresh-token rotation
- one-time WebSocket ticket
- Extension ↔ Desktop communication through backend
- Maven backend
- presence in server memory
- UUID string IDs
- friend-code based discovery
- room playback/version persisted in DB

Do not duplicate or contradict `docs/architecture/plan.md`.
If an architecture decision changes, update that file with the reason.
