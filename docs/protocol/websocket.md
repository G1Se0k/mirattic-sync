# WebSocket Protocol

상태: Phase 1에서 연결 / presence / friend, Phase 2에서 room / playback / sync, Phase 4에서 `playback:content-change` 확정. chat은 이후.

## 연결

1. `POST /api/ws-ticket` (Bearer access token) → `{ "ticket": "..." }` (일회용, 30초, 서버 메모리)
2. `ws://<host>/ws?ticket=<ticket>` — ticket이 없거나 이미 사용됐거나 만료됐으면 handshake 401
3. Origin 헤더가 있으면 `app.allowed-origins`에 포함돼야 함
4. 인바운드 텍스트 프레임 최대 16KB
5. Extension은 background service worker가 연결을 가짐(결정 69)·20초마다 keepalive로 `sync:request`를 보냄. 서버가 30초마다 ping 프레임을 보냄 (Cloudflare의 100초 유휴 종료 방지, 브라우저가 자동 pong). 운영 주소 `wss://sync.mirattic.com/ws`

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

Extension은 사용자가 동의한 뒤에만 `presence:update`에 시청 중인 YouTube 영상(과 Netflix / Laftel 제어를 켠 경우 그 콘텐츠)을 보낸다. 탭이 영상을 벗어나면 null.

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
| `watch:request` | S→C | `UserSummary` | 친구가 같이 보자고 요청함 (`POST /api/rooms/requests`). `userId` = 요청한 사람. 받은 사람은 초대(`POST /api/rooms` 또는 `/api/rooms/{id}/invites`)로 응답 |
| `room:update` | S→C | 없음, 또는 `{ muted }` | 참가 / 나감 / 방 닫힘 시 모든 멤버에게. 클라이언트는 `GET /api/rooms/{id}`로 다시 조회 (404면 닫힘). 채팅 알림 설정을 바꾸면 그 사용자의 연결에만 `{ muted }`를 담아 보냄 → 조회 응답 전에 바로 적용 |
| `playback:play` `playback:pause` `playback:seek` | C→S | `PlaybackCommand` `{ positionMs, capturedAt }` | HOST만 (`not_host`). `capturedAt`은 호스트가 추정한 **서버 시각**. 미래이거나 5초보다 오래됐으면 서버 수신 시각으로 대체. 세션당 초당 20회 |
| `playback:content-change` | C→S | `RoomContent` | HOST만. 호스트 플레이어의 영상이 바뀌었을 때 다음 명령 전에 보냄. 방 콘텐츠를 바꾸고 0초·일시정지로 초기화, version 증가 → `playback:update` + `room:update`. YouTube는 contentId가 11자 영상 ID, Netflix는 1–12자리 숫자, Laftel은 `작품ID/에피소드ID`(각 1–10자리 숫자)여야 함 (`bad_payload`). playback 명령과 같은 초당 예산. `series`가 이전 콘텐츠와 같으면 멤버 클라이언트가 묻지 않고 새 영상을 열고, 다르면 팝업으로 물음 (결정 67) |

호스트 이탈 (결정 67): 호스트 탭의 영상이 사라지면(시청 페이지를 벗어남, 탭 닫힘) 호스트 클라이언트가 재생 중이던 위치로 `playback:pause`를 보냄. 호스트의 연결이 방에서 모두 빠지면(`room:leave`, 연결 끊김 — 창 · side panel 닫기, 방 화면 나가기) 서버가 재생 중인 방을 지금 위치로 일시정지하고 `playback:update`를 보냄.
| `playback:update` | S→C | `PlaybackState` | 방에 참가한 연결 전부에게. envelope `version` = payload `version`, 방마다 1씩 증가 (DB 행 잠금으로 순서 보장) |
| `sync:request` | C→S | 없음 (`reqId` 필수) | |
| `sync:response` | S→C | `{ reqId }` | `serverTime`으로 시계 offset 추정: `offset = serverTime − (보낸 시각 + RTT/2)`, RTT가 가장 작은 샘플 사용 |

멤버는 방 콘텐츠가 자기 플레이어와 다르면 동기화하지 않고(`other-content`) "이 영상 열기"를 보여준다. 호스트가 영상을 바꾸면 팝업으로 묻고, 이전 콘텐츠와 `series`가 같을 때만 묻지 않고 탭을 새 영상으로 이동한다 (결정 67). 같은 영상에서 `series`만 바뀐 `playback:content-change`는 재생 상태를 초기화하지 않고 `room:update`만 보낸다.

### 동기화 (`packages/sync-core`)

- 호스트: `publishHost`가 플레이어 변경을 명령으로 보낸다. 200ms 안의 연속 조작은 마지막 상태로 모아서 보낸다 (버리지 않음)
- 멤버: `SyncFollower`
  - version이 현재 이하인 상태는 버린다
  - 재생 / 일시정지 불일치는 즉시 맞춘다
  - 위치 차이: `< 500ms` 무시 · `500–1500ms` 재생 중이면 1초 뒤 재확인 · `1500–3000ms` 1초 뒤 한 번 더 확인하고 그래도 어긋나면 seek (호스트 이벤트 직후면 즉시) · `> 3000ms` 즉시 seek
  - 광고 중(`adPlaying`)에는 보정하지 않는다. 호스트는 광고 중 스냅샷을 보내지 않는다
  - provider별 `driftOverride` 적용
  - `seekable === false`인 플레이어(Netflix)는 seek하지 않고 `manual` 상태(`driftMs`, `targetMs`)로 사용자에게 이동할 위치를 안내. 재생 / 일시정지는 그대로 맞춤

## 확정된 이벤트 (Phase 4 — chat)

| type | 방향 | payload | 비고 |
|---|---|---|---|
| `chat:message` | C→S | `{ text, mediaPositionMs? }` | 멤버만 (`not_member`). text는 앞뒤 공백 제거 후 1–1000자, `mediaPositionMs` ≥ 0 (아니면 `bad_payload`). 세션당 초당 5회 |
| `chat:delete` | S→C | `{ id }` 또는 `{ userId }` | 메시지 삭제(`DELETE /api/rooms/{id}/messages/{messageId}`, envelope `userId` = 지운 사람) 또는 계정 삭제(`{ userId }` = 그 사람의 모든 메시지). `chat:message`와 같이 모든 멤버의 연결에게. 채팅은 `{ id }`를 "삭제된 메시지입니다" 자리표시로 바꾸고(결정 71, 기록에도 `deleted: true`로 남음), `{ userId }`는 목록에서 뺀다. 늦게 도착한 같은 메시지에도 적용. 방 목록은 배지·알림에서 뺀다 |
| (서버) 빈 방 닫기 | S→C | `room:update` | 결정 75: 참가 중인 연결이 없는 상태가 1–2분 이어진 방은 서버가 닫고 멤버에게 알림 |
| `room:read` | C→S | `{}` | 멤버만 (`not_member`). 지금까지 온 메시지를 읽음으로 표시하고 내 연결들에 `room:update` (목록 재조회). Extension은 패널을 닫아도 방에 들어가 있으므로(결정 69), 패널이 그 방을 보여 줄 때만 보냄 — 열 때, 보는 중 메시지가 올 때(0.5초 모아서), 화면을 닫을 때 |
| `pause:request` | C→S, S→C | `{ reason? }` (200자 이하) | 결정 70. 멤버만 (호스트 `bad_payload`, 비멤버 `not_member`). 멤버·방마다 30초에 1번 (`rate_limited`). 서버는 호스트의 모든 연결로 같은 이름으로 보냄: envelope `userId` = 요청한 멤버, `roomId`, payload `{ reason }`(앞뒤 공백 제거) |
| `chat:message` | S→C | `ChatMessage` `{ id, roomId, userId, text, mediaPositionMs?, kind?, createdAt, deleted }` | **방의 모든 멤버의 연결**에게 (참가하지 않은 멤버, 보낸 사람 포함). envelope `userId` = 보낸 사람. 기록은 `GET /api/rooms/{id}/messages`. 리액션(`reaction:add`)은 결정 78로 없어짐 → `unknown_type` |
| `chat:log` | S→C | `ChatMessage` (`kind` 있음) | 결정 78. 방에 참가 중인 연결에게만 (나머지는 기록에서 봄). `kind`: `join` / `leave`(`text` = 그때 이름; 첫 연결이 방에 들어올 때, 마지막 연결이 나간 뒤 10초 유예가 지나면), `play` / `pause`(호스트 명령으로 재생 상태가 바뀔 때만, 위치 포함. 일시정지는 3초 붙잡아 두고 그 안에 재생이 오면 움직였을 때만 `seek` 한 줄 — 시크바 끌기, 결정 79), `seek`(3초 안에 같은 호스트의 seek가 이어지면 같은 `id`의 줄을 새 위치로 다시 보냄 → 클라이언트는 교체), `content`(`text` = 새 영상 제목), `kick` / `host`(`text` = 내보낸 멤버 / 새 호스트 이름, 결정 79). 읽지 않은 수·알림·삭제·신고 대상 아님 |

읽지 않은 수: 서버는 `room:join`, `room:leave`, 연결 끊김 때 그 멤버의 읽음 위치(`last_read_seq`)를 방의 마지막 메시지 순번으로 기록한다 (메시지 저장과 같은 방 행 잠금 아래). `room:leave`·끊김은 기록한 뒤에 `room:update`를 보낸다.

재연결 후 최근 기록을 다시 받으면, 화면의 메시지 중 그 페이지 범위 안인데 페이지에 없는 것은 끊긴 동안 삭제된 것으로 보고 뺀다 (`reconcile`).

타임스탬프(`mediaPositionMs`)를 누르면 호스트에게만 확인 창을 띄운 뒤 이동한다 (호스트의 이동이 방 전체에 전파됨). 멤버에게는 표시만.

## 규칙

- 클라이언트는 자신이 가진 version보다 작거나 같은 `playback:*`를 버린다.
- 모든 room 이벤트는 서버에서 멤버십을 검증한다.
- 삭제된 계정의 연결은 서버가 닫는다. 삭제 직전에 받은 ticket으로 연결해도 연결 직후 계정 확인에서 닫힌다.
- 시간 값은 UTC epoch ms.
