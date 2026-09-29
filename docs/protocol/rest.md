# REST API (Phase 1)

모든 `/api/**`는 `Authorization: Bearer <access token>` 필요 (`/api/auth/**` 제외). 오류는 RFC 9457 problem JSON (`detail` 필드).
ID는 UUID 문자열, 시간은 epoch ms.

## Auth

| Method | Path | Body | 응답 |
|---|---|---|---|
| POST | `/api/auth/signup` | `{ email, password(8–128), displayName(≤32) }` | 201 `AuthTokens` / 409 이메일 중복 |
| POST | `/api/auth/login` | `{ email, password }` | 200 `AuthTokens` / 401 |
| POST | `/api/auth/refresh` | `{ refreshToken }` | 200 새 `AuthTokens` / 401 |
| POST | `/api/auth/logout` | `{ refreshToken }` | 204 (해당 로그인의 토큰 family 전부 폐기) |

- access token: HS256 JWT, 15분, `sub` = userId, `iss` = `mirattic`
- refresh token: 불투명 랜덤 32바이트, 30일, DB에는 SHA-256만 저장
- **rotation + 재사용 감지**: refresh할 때마다 새 토큰을 발급하고 이전 토큰을 폐기한다. 폐기된 토큰이 다시 오면 그 로그인에서 나온 토큰 전체(family)를 폐기한다.
  클라이언트는 refresh를 동시에 하나만 보내야 한다 (`packages/client`가 보장).
- `/api/auth/**`는 IP당 분당 20회 제한 (429)

## Users

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/me` | `Me` `{ id(UID), email?, providers[], displayName, friendCode, presenceVisibility, positionVisibility }` |
| POST | `/api/me/friend-code` | 친구 코드 재발급 (이전 코드는 즉시 무효) → `Me`. UI에서는 뺐음 (2026-09-29 사용자 요청) |
| PUT | `/api/me/privacy` | `{ presenceVisibility, positionVisibility }` → `Me` |
| DELETE | `/api/me` | `{ password }` → 204. 계정과 데이터 삭제 (Phase 9). 비밀번호가 틀리면 **403** (401이면 클라이언트가 refresh 후 재시도하므로). IP당 분당 제한은 `/api/auth/**`와 같음 (429). 삭제 후: 호스트인 방은 닫히고 나머지 방에서는 빠짐 (멤버들에게 `room:update`, 남은 방에는 `chat:delete { userId }`), 친구·요청 상대에게 `friend:update`, 내 WebSocket 연결은 모두 닫힘, 기존 access token은 즉시 401 |

삭제 이후 access token은 만료 전이라도 서버가 계정 존재를 확인해 401로 거절한다 (요청마다 기본 키 조회 한 번).

## Friends / Blocks

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/friends` | `FriendView[]` (presence 포함, 공개 규칙 적용) |
| GET | `/api/friends/requests` | `{ incoming, outgoing }` |
| POST | `/api/friends/requests` | `{ friendCode }` → 요청을 받은 `UserSummary`. 상대가 이미 요청했으면 즉시 친구. 없는 코드와 차단 관계는 둘 다 404, 자기 코드는 400, 중복은 409 |
| POST | `/api/friends/requests/{id}/accept` | 받은 사람만 가능, 아니면 404 |
| DELETE | `/api/friends/requests/{id}` | 거절(받은 사람) 또는 취소(보낸 사람) |
| DELETE | `/api/friends/{userId}` | 친구 삭제 |
| GET | `/api/blocks` | 차단 목록 |
| PUT | `/api/blocks/{userId}` | 차단. 친구 관계와 대기 중인 요청을 삭제 |
| DELETE | `/api/blocks/{userId}` | 차단 해제 |
| POST | `/api/ws-ticket` | `{ ticket }` |

## Rooms (Phase 2)

멤버가 아닌 방은 모두 404 (방 ID로 존재 여부를 알 수 없게).

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/rooms` | `{ content: RoomContent, inviteIds: string[] }` → `RoomView`. 만든 사람이 HOST. 참가 중인 사람이 1–2분 동안 없으면 서버가 닫음(결정 75). 초대는 수락된 친구만(아니면 400), 최대 7명. `youtube` 콘텐츠는 `contentId`가 11자 영상 ID, `netflix`는 1–12자리 숫자, `laftel`은 `작품ID/에피소드ID`(각 1–10자리 숫자)(아니면 400). 초대받은 사람에게 `room:invite` |
| POST | `/api/rooms/{id}/invites` | `{ userIds }` → `RoomView`. HOST만(403), 친구만(400), 전체 초대 7명까지. 이미 멤버면 무시. 새로 초대된 사람에게 `room:invite`, 기존 멤버에게 `room:update` |
| POST | `/api/rooms/requests` | `{ friendId }` → 202. 친구에게 같이 보자고 요청 (`watch:request`). 친구가 아니면 404, 오프라인이면 409, 같은 친구에게 30초 안에 다시 보내면 429 |
| POST | `/api/rooms/join` | `{ code }` → `RoomView`. 방 코드(대소문자·`-` 무시)를 아는 누구나 MEMBER로 입장, 이미 멤버면 그대로(결정 77). 없는 코드·기존 멤버와 차단 관계 404, 8명 가득 409, 사용자당 분당 10번 초과 429. 새로 들어오면 기존 멤버에게 `room:update` |
| GET | `/api/rooms` | 내가 멤버인 방 `RoomView[]` (초대받은 방 포함) |
| GET | `/api/rooms/{id}` | `RoomView` `{ id, content, members: [{ user, role, present }], createdAt, unread, muted, code }` (`code` = 방 코드 8자, 결정 77) |
| GET | `/api/rooms/{id}/messages?before=` | 채팅 100개 `ChatMessage[]`(방 기록 `kind` 줄 포함, 결정 78), 오래된 순: 최근 것, 또는 메시지 ID `before`보다 앞 (`createdAt`, `id` 순). 멤버가 아니거나 `before`가 이 방 메시지가 아니면 404 |
| DELETE | `/api/rooms/{id}/messages/{messageId}` | 204. 보낸 사람 또는 방 호스트만 (아니면 403). 멤버가 아니거나 이 방 메시지가 아니거나 이미 삭제됐거나 방 기록(`kind`)이면 404. 소프트 삭제(결정 71): `text` ""·`mediaPositionMs` 없음·`deleted: true`로 기록에 남음, 읽지 않은 수에서 제외. 모든 멤버의 연결에 `chat:delete { id }` |
| PUT | `/api/rooms/{id}/members/me/muted` | `{ muted }` → 204. 이 방의 내 채팅 알림 끄기/켜기. 저장 후 **내 모든 연결에만** `room:update { muted }` (다른 앱이 조회를 기다리지 않고 새 설정으로 알림). 멤버가 아니면 404 |
| DELETE | `/api/rooms/{id}/members/me` | 나가기 / 초대 거절. HOST가 나가면 방 삭제. 모든 멤버에게 `room:update` |

`RoomContent` = `{ provider, contentId, title, durationMs?, canonicalUrl?(https만), series?([A-Za-z0-9_-] 1–128자) }`. `series`가 같으면 같은 묶음(YouTube 재생목록, Laftel 작품, Netflix의 이어 본 화들)이라 멤버가 호스트의 다음 영상으로 묻지 않고 따라감 (결정 67). `unread`(다른 사람이 쓴 메시지 중 내가 마지막으로 방을 연 뒤의 수, 방 기록 `kind` 줄과 삭제된 메시지 제외)와 `muted`는 요청한 사람 기준 (초대 이벤트·초대 응답의 `RoomView`에서는 0 / false). 초대 = 멤버십 부여이며 별도 수락 단계는 없다.

## Reports (Phase 9)

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/reports` | `{ messageId \| userId, reason, detail? }` → 204. `messageId`와 `userId` 중 **하나만** (아니면 400). `reason` = `SPAM` · `HARASSMENT` · `INAPPROPRIATE` · `OTHER`, `detail` ≤ 500자 |

- 신고할 수 있는 것은 신고자가 볼 수 있던 것만: 내가 멤버인 방의 다른 사람 메시지, 또는 친구 · 같은 방 멤버 · 내가 차단한 사용자. 그 밖은 404 (사용자 ID 탐색 방지), 나 자신은 400
- 메시지 신고는 방 ID와 내용을 복사해 저장 (원래 메시지가 지워져도 남음). 같은 메시지를 다시 신고하면 저장하지 않고 204 (한도에 닿아 있어도)
- 신고자당 24시간에 20건 (429). 신고자의 `users` 행을 잠가 한 사람의 신고는 하나씩 처리 (동시 요청으로 한도·중복을 넘지 못함)
- 운영자 확인용 화면은 없음 (DB `reports`). 서버 로그에는 신고 ID만

## 친구 코드

- 8자, 알파벳 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(0/O, 1/I/L 제외, 31자 → 약 8.5×10¹¹개). 저장할 때는 대시 없이, 표시할 때는 `XXXX-XXXX`
- 입력은 대소문자, 대시, 공백을 무시한다 (`k7qm-4xpr` = `K7QM4XPR`)
- 본인에게만 보인다 (`Me`에만 포함되고 `UserSummary`에는 없음)
- 이메일 검색은 없앴다. 가입 여부 노출을 막고, 이메일이 없는 OAuth 사용자도 추가할 수 있게 하기 위해서다
