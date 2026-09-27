# WebSocket Protocol (초안 — Phase 1/2에서 확정)

## 연결

1. `POST /api/ws-ticket` (Bearer access token) → `{ ticket }` (일회용, 30초)
2. `wss://<host>/ws?ticket=<ticket>`

## Envelope (`packages/types`)

```ts
// client → server. userId를 보내지 않는다. 보내더라도 서버는 무시한다.
type ClientEvent<T> = { type: string; reqId?: string; roomId?: string; payload: T };
// server → client. 서버가 인증된 세션에서 userId, version, serverTime을 채운다.
type ServerEvent<T> = { type: string; roomId?: string; userId?: string; version?: number; serverTime: number; payload: T };
```

## 이벤트

| type | 방향 | 비고 |
|---|---|---|
| `presence:update` | C→S, S→C | 서버가 친구 관계 / 차단 / visibility 확인 후 전달. 위치는 같은 room에만 |
| `room:join` `room:leave` `room:invite` | C→S, S→C | 멤버십 서버 검증 |
| `playback:play` `playback:pause` `playback:seek` `playback:content-change` | C→S (host만), S→C | 서버가 room별 version +1 |
| `playback:update` | S→C | 현재 room playback 상태 전체 |
| `sync:request` / `sync:response` | C→S / S→C | 시계 offset 추정용, `serverTime` 포함 |
| `chat:message` | C→S, S→C | `mediaPositionMs` 선택 |
| `reaction:add` | C→S, S→C | Phase 8 |
| `error` | S→C | `{ reqId, code, message }` |

## 규칙

- 클라이언트는 자신이 가진 version보다 작거나 같은 `playback:*`를 버린다.
- 모든 room 이벤트는 서버에서 멤버십을 검증한다.
- 시간 값은 UTC epoch ms.
