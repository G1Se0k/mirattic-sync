# Security and Policy Module

Security requirements:
- never store provider passwords/cookies/session tokens
- never proxy, download, decrypt, or redistribute media
- never bypass DRM, region restrictions, or stream limits
- validate room/friend authorization server-side
- keep secrets out of logs
- use restrictive CORS
- use one-time WebSocket tickets

Provider policy workflow:
- verify official policy immediately before provider work
- record findings under `docs/platform-policy/`
- include verification date
- mark uncertain behavior explicitly
- choose conservative behavior when unclear

Platform-policy source of truth:
`docs/platform-policy/README.md`
