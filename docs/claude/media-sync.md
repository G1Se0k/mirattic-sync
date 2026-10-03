# Media Sync Module

Use these as authoritative references:
- `docs/architecture/plan.md`
- `docs/protocol/websocket.md`
- `docs/protocol/rest.md`

Key rules:
- provider adapters return local player snapshots; room layer wraps them into PlaybackState
- host-authoritative room model for MVP
- playback state uses positionMs, capturedAt, playing, rate (decision 96: positions advance at elapsed × rate), version
- capturedAt is based on estimated server time
- late versions are discarded
- drift behavior follows `docs/protocol/websocket.md`
- host commands are coalesced in 200ms windows
- server rate limit is 20 playback commands/sec
- MockMediaProvider must remain usable for sync testing
- provider-specific behavior stays isolated

Do not redefine protocol events here; update `docs/protocol/websocket.md`.
