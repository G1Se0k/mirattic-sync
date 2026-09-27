# WebSocket Protocol

상태: Phase 1에서 연결 / presence / friend, Phase 2에서 room / playback / sync 확정. chat은 이후.

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
| `error` | S→C | `{ reqId, code }` | code: `bad_json`, `bad_payload`, `unknown_type`, `rate_limited`, `not_member`, `not_host` |

### Presence 공개 규칙 (`PresenceService.view`)

- 오프라인 → `{ status: "OFFLINE" }`
- 온라인, 시청 안 함 또는 `presenceVisibility != FRIENDS` → `{ status: "ONLINE" }`
- 시청 중이고 `presenceVisibility == FRIENDS` → `{ status: "WATCHING", media }`
  - `positionVisibility != FRIENDS`면 `media.positionMs` 제거 (기본값 ROOM_ONLY)
- 차단하면 친구 관계가 삭제되므로 presence가 양방향 모두 끊긴다

### MediaPresence 검증 (서버)

provider는 `youtube|netflix|laftel`, title 1–300자, `thumbnailUrl` / `canonicalUrl`은 `https://`만 허용(최대 2048자),
숫자 필드는 0 이상.

## 확정된 이벤트 (Phase 2 — room / playback)

room 이벤트는 envelope의 `roomId`가 필수. 멤버가 아니면 `not_member`.

| type | 방향 | payload | 비고 |
|---|---|---|---|
| `room:join` | C→S | `{}` | 멤버십 확인 후 이 연결을 방에 등록. 응답으로 현재 `playback:update`(version 0 포함). 재연결할 때마다 다시 보내야 함 |
| `room:leave` | C→S | `{}` | 이 연결만 방에서 빠짐 (멤버십은 유지). 멤버십 삭제는 REST. 멤버십을 확인하지 않음: 자기 연결만 빼는 멱등 동작이라 타인에게 영향·정보 노출이 없고, REST로 나간 뒤 화면 정리 때 보내는 `room:leave`가 오류가 되지 않게 하기 위함 |
| `room:invite` | S→C | `RoomView` | 초대받은 사람에게 |
| `room:update` | S→C | 없음 | 참가 / 나감 / 방 닫힘 시 모든 멤버에게. 클라이언트는 `GET /api/rooms/{id}`로 다시 조회 (404면 닫힘) |
| `playback:play` `playback:pause` `playback:seek` | C→S | `PlaybackCommand` `{ positionMs, capturedAt }` | HOST만 (`not_host`). `capturedAt`은 호스트가 추정한 **서버 시각**. 미래이거나 5초보다 오래됐으면 서버 수신 시각으로 대체. 세션당 초당 20회 |
| `playback:update` | S→C | `PlaybackState` | 방에 참가한 연결 전부에게. envelope `version` = payload `version`, 방마다 1씩 증가 (DB 행 잠금으로 순서 보장) |
| `sync:request` | C→S | 없음 (`reqId` 필수) | |
| `sync:response` | S→C | `{ reqId }` | `serverTime`으로 시계 offset 추정: `offset = serverTime − (보낸 시각 + RTT/2)`, RTT가 가장 작은 샘플 사용 |

`content-change`는 Phase 4 (YouTube 다음 영상)에서 추가한다.

### 동기화 (`packages/sync-core`)

- 호스트: `publishHost`가 플레이어 변경을 명령으로 보낸다. 200ms 안의 연속 조작은 마지막 상태로 모아서 보낸다 (버리지 않음)
- 멤버: `SyncFollower`
  - version이 현재 이하인 상태는 버린다
  - 재생 / 일시정지 불일치는 즉시 맞춘다
  - 위치 차이: `< 500ms` 무시 · `500–1500ms` 재생 중이면 1초 뒤 재확인 · `1500–3000ms` 1초 뒤 한 번 더 확인하고 그래도 어긋나면 seek (호스트 이벤트 직후면 즉시) · `> 3000ms` 즉시 seek
  - 광고 중(`adPlaying`)에는 보정하지 않는다
  - provider별 `driftOverride` 적용

## 예정 이벤트

| type | 방향 | 비고 |
|---|---|---|
| `playback:content-change` | C→S (host만), S→C | Phase 4 |
| `chat:message` | C→S, S→C | `mediaPositionMs` 선택 |
| `reaction:add` | C→S, S→C | Phase 8 |

## 규칙

- 클라이언트는 자신이 가진 version보다 작거나 같은 `playback:*`를 버린다.
- 모든 room 이벤트는 서버에서 멤버십을 검증한다.
- 시간 값은 UTC epoch ms.
