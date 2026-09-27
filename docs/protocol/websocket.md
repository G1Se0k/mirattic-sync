# WebSocket Protocol

상태: Phase 1에서 연결 / presence / friend 이벤트 확정. room / playback / chat은 Phase 2 이후.

## 연결

1. `POST /api/ws-ticket` (Bearer access token) → `{ "ticket": "..." }` (일회용, 30초, 서버 메모리)
2. `ws://<host>/ws?ticket=<ticket>` — ticket이 없거나 이미 사용됐거나 만료됐으면 handshake 401
3. Origin 헤더가 있으면 `app.allowed-origins`에 포함돼야 함
4. 인바운드 텍스트 프레임 최대 16KB

클라이언트(`packages/client` `connectSocket`)는 재연결할 때마다 새 ticket을 받고, 지수 backoff(최대 30초)를 쓴다.
ticket 요청이 401이면 재연결을 멈춘다(세션 종료).

## Envelope (`packages/types`)

```ts
// client → server. userId를 보내지 않는다. 보내더라도 서버는 무시한다.
type ClientEvent<T> = { type: string; reqId?: string; roomId?: string; payload: T };
// server → client. 서버가 인증된 세션에서 userId, version, serverTime을 채운다.
type ServerEvent<T> = { type: string; roomId?: string; userId?: string; version?: number; serverTime: number; payload: T };
```

null 필드는 JSON에서 생략된다.

## 확정된 이벤트 (Phase 1)

| type | 방향 | payload | 비고 |
|---|---|---|---|
| `presence:update` | C→S | `MediaPresence \| null` | null이면 시청 종료. 세션당 250ms보다 빠른 연속 전송은 `rate_limited` |
| `presence:update` | S→C | `PresenceView` `{ status, media? }` | `userId` = 친구. 수락된 친구에게만 전송 |
| `friend:update` | S→C | 없음 | 친구 요청 / 수락 / 거절 / 삭제 / 차단 시 양쪽에 전송. 클라이언트는 목록을 다시 조회 |
| `error` | S→C | `{ reqId, code }` | code: `bad_json`, `bad_payload`, `unknown_type`, `rate_limited` |

### Presence 공개 규칙 (`PresenceService.view`)

- 오프라인 → `{ status: "OFFLINE" }`
- 온라인, 시청 안 함 또는 `presenceVisibility != FRIENDS` → `{ status: "ONLINE" }`
- 시청 중이고 `presenceVisibility == FRIENDS` → `{ status: "WATCHING", media }`
  - `positionVisibility != FRIENDS`면 `media.positionMs` 제거 (기본값 ROOM_ONLY)
- 차단하면 친구 관계가 삭제되므로 presence가 양방향 모두 끊긴다

### MediaPresence 검증 (서버)

provider는 `youtube|netflix|laftel`, title 1–300자, `thumbnailUrl` / `canonicalUrl`은 `https://`만 허용(최대 2048자),
숫자 필드는 0 이상.

## 예정 이벤트 (Phase 2+)

| type | 방향 | 비고 |
|---|---|---|
| `room:join` `room:leave` `room:invite` | C→S, S→C | 멤버십 서버 검증 |
| `playback:play` `playback:pause` `playback:seek` `playback:content-change` | C→S (host만), S→C | 서버가 room별 version +1 |
| `playback:update` | S→C | 현재 room playback 상태 전체 |
| `sync:request` / `sync:response` | C→S / S→C | 시계 offset 추정용 |
| `chat:message` | C→S, S→C | `mediaPositionMs` 선택 |
| `reaction:add` | C→S, S→C | Phase 8 |

## 규칙

- 클라이언트는 자신이 가진 version보다 작거나 같은 `playback:*`를 버린다.
- 모든 room 이벤트는 서버에서 멤버십을 검증한다.
- 시간 값은 UTC epoch ms.
