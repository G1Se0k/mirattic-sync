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
| POST | `/api/me/friend-code` | 친구 코드 재발급 (이전 코드는 즉시 무효) → `Me` |
| PUT | `/api/me/privacy` | `{ presenceVisibility, positionVisibility }` → `Me` |

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
| POST | `/api/rooms` | `{ content: RoomContent, inviteIds: string[] }` → `RoomView`. 만든 사람이 HOST. 초대는 수락된 친구만(아니면 400), 최대 7명. `youtube` 콘텐츠는 `contentId`가 11자 영상 ID, `netflix`는 1–12자리 숫자, `laftel`은 `작품ID/에피소드ID`(각 1–10자리 숫자)(아니면 400). 초대받은 사람에게 `room:invite` |
| POST | `/api/rooms/{id}/invites` | `{ userIds }` → `RoomView`. HOST만(403), 친구만(400), 전체 초대 7명까지. 이미 멤버면 무시. 새로 초대된 사람에게 `room:invite`, 기존 멤버에게 `room:update` |
| POST | `/api/rooms/requests` | `{ friendId }` → 202. 친구에게 같이 보자고 요청 (`watch:request`). 친구가 아니면 404, 오프라인이면 409, 같은 친구에게 30초 안에 다시 보내면 429 |
| GET | `/api/rooms` | 내가 멤버인 방 `RoomView[]` (초대받은 방 포함) |
| GET | `/api/rooms/{id}` | `RoomView` `{ id, content, members: [{ user, role, present }], createdAt }` |
| GET | `/api/rooms/{id}/messages` | 최근 채팅 100개 `ChatMessage[]`, 오래된 순. 멤버가 아니면 404 |
| DELETE | `/api/rooms/{id}/members/me` | 나가기 / 초대 거절. HOST가 나가면 방 삭제. 모든 멤버에게 `room:update` |

`RoomContent` = `{ provider, contentId, title, durationMs?, canonicalUrl?(https만) }`. 초대 = 멤버십 부여이며 별도 수락 단계는 없다.

## 친구 코드

- 8자, 알파벳 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(0/O, 1/I/L 제외, 31자 → 약 8.5×10¹¹개). 저장할 때는 대시 없이, 표시할 때는 `XXXX-XXXX`
- 입력은 대소문자, 대시, 공백을 무시한다 (`k7qm-4xpr` = `K7QM4XPR`)
- 본인에게만 보인다 (`Me`에만 포함되고 `UserSummary`에는 없음)
- 이메일 검색은 없앴다. 가입 여부 노출을 막고, 이메일이 없는 OAuth 사용자도 추가할 수 있게 하기 위해서다
