# REST API (Phase 1)

모든 `/api/**`는 `Authorization: Bearer <access token>` 필요 (`/api/auth/**` 제외). 오류는 RFC 9457 problem JSON (`detail` 필드).
ID는 UUID 문자열, 시간은 epoch ms.

## Auth

Mirattic Auth가 로그인을 전부 맡는다 (결정 82, Auth 저장소 `docs/migration.md` 옵션 B). Sync는 토큰을 발급·저장하지 않는다.

### Mirattic 계정 로그인 (확장, `chrome.identity.launchWebAuthFlow`)
| Method | Path | 설명 |
|---|---|---|
| GET | `/auth/start?redirect=&challenge=&reauth=` | `redirect`는 허용된 확장 redirect(`AUTH_EXTENSION_REDIRECTS`, `https://<id>.chromiumapp.org/`)와 정확히 같아야 함, `challenge`는 확장이 만든 PKCE S256(43자). `reauth=true`면 Auth에 `prompt=login`(계정 삭제 전 비밀번호 재확인). state·서버 PKCE를 메모리에 10분 보관, state를 `sync_login` 쿠키(HttpOnly, SameSite=Lax, path `/auth/callback`)에 묶고 Auth `/oauth2/authorize`로 302. 그 외 400 |
| GET | `/auth/callback` | Auth가 돌려보냄. state·쿠키 확인 → code를 client secret(Basic) + verifier로 교환 → ID token으로 `sub`·`name`·`auth_time` 확인 → 처음 보는 UID면 Sync `users` 행 생성(제품 필드만) → `<redirect>?handoff=<일회용 코드>`로 302. 실패는 `<redirect>?error=…` (`state_mismatch`, `access_denied`, `exchange_failed`). URL에 토큰은 절대 없음 |
| POST | `/api/auth/handoff` | `{ code, verifier }` → 200 `AuthTokens` (Auth access/refresh token). 60초, 1회용, `/auth/start`의 challenge와 맞는 verifier만. 그 외 401 |

### 토큰
| Method | Path | Body | 응답 |
|---|---|---|---|
| POST | `/api/auth/refresh` | `{ refreshToken }` | Auth `/oauth2/token`으로 중계. 200 새 `AuthTokens` / 401 (Auth `invalid_grant` 또는 Sync 프로필 없음 → 클라이언트 로그아웃) / 502 (Auth 불가·설정 오류: 토큰 유지) |
| POST | `/api/auth/logout` | `{ refreshToken }` | 204. Auth `/oauth2/revoke`로 중계(최선) |

- API의 access token: Mirattic Auth, RS256, Auth JWKS, `iss` = `AUTH_ISSUER`, `aud` ∋ `mirattic-sync`, `scope` 있음(ID token 거부), 15분, `sub` = UID. Sync 프로필이 삭제된 UID면 401
- refresh token: Auth 발급, 128자, 30일, 사용할 때마다 회전, 재사용 감지는 Auth가 함 (10초 유예 후 재사용 → 그 로그인 전체 폐기)
- 클라이언트는 refresh를 동시에 하나만 보내야 한다 (`packages/client`가 보장)
- `/api/auth/**`, `/auth/**`는 IP당 분당 20회 제한 (429)

## Users

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/me` | `Me` `{ id(UID), email?, displayName, friendCode, presenceVisibility, positionVisibility }`. `email`은 Mirattic Auth UserInfo에서 매번 읽음(실패하면 없음) |
| POST | `/api/me/friend-code` | 친구 코드 재발급 (이전 코드는 즉시 무효) → `Me`. UI에서는 뺐음 (2026-09-29 사용자 요청) |
| PUT | `/api/me/privacy` | `{ presenceVisibility, positionVisibility }` → `Me` |
| DELETE | `/api/me` | `{ code, verifier }` → 204. Sync 프로필과 데이터 삭제 (Phase 9, 결정 82). `reauth=true` 로그인의 handoff여야 하고 같은 UID, `auth_time` 5분 이내가 아니면 **403** (401이면 클라이언트가 refresh 후 재시도하므로). 그 재인증 로그인은 Auth에서 바로 폐기. Mirattic 계정은 Auth에 남음. IP당 분당 제한은 `/api/auth/**`와 같음 (429). 삭제 후: 호스트인 방은 닫히고 나머지 방에서는 빠짐 (멤버들에게 `room:update`, 남은 방에는 `chat:delete { userId }`), 친구·요청 상대에게 `friend:update`, 내 WebSocket 연결은 모두 닫힘, 기존 access token은 즉시 401 |

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
| POST | `/api/rooms` | `{ content: RoomContent, inviteIds: string[] }` → `RoomView`. 만든 사람이 HOST. 참가 중인 사람이 1–2분 동안 없으면 서버가 닫음(결정 75). 초대는 수락된 친구만(아니면 400), 최대 7명. 초대받은 친구는 초대장만 받고 입장해야 멤버(결정 85). `youtube` 콘텐츠는 `contentId`가 11자 영상 ID, `netflix`는 1–12자리 숫자, `laftel`은 `작품ID/에피소드ID`(각 1–10자리 숫자)(아니면 400). 초대받은 사람에게 `room:invite` |
| POST | `/api/rooms/{id}/invites` | `{ userIds }` → `RoomView`. HOST만(403), 친구만(400), 한 번에 7명까지. 이미 멤버면 무시. 새로 초대된 사람은 **초대장**을 받음(`room:invite`, 멤버 아님 — 결정 85, 입장하면 멤버). 내 합류 요청에 대한 응답이면 바로 멤버 + `watch:answer`. 기존 멤버에게 `room:update` |
| GET | `/api/rooms/invitations` | → `RoomView[]`. 나를 초대한 방들(최신순). 수락·거절 전까지, 초대 후 30초 동안만(결정 87, 다시 초대하면 새로 30초). 각각 `expiresInMs`(남은 시간). 30초가 지난 초대의 수락은 404 |
| POST | `/api/rooms/{id}/invitation` | → `RoomView`. 초대 수락 → 멤버가 됨, 기존 멤버에게 `room:update`. 초대가 없으면(취소·방 닫힘·차단) 404, 방이 가득 차면 409(초대는 남음) |
| DELETE | `/api/rooms/{id}/invitation` | → 204. 초대 거절 |
| POST | `/api/rooms/requests` | `{ friendId }` → 202 `{ askedAt }`(이 요청의 식별, `watch:decline`에 같은 값). 친구에게 같이 보자고 요청 (`watch:request`). 친구가 아니면 404, 오프라인이면 409, 내가 멤버인 방에 친구가 지금 참가 중이면 409(`detail`: `already in the same room`, 이미 같이 있음), 같은 친구에게 30초 안에 다시 보내면 429 |
| GET | `/api/rooms/requests` | → `string[]`. 내가 보내고 아직 답을 기다리는 합류 요청의 친구 ID (취소하거나 그 친구의 초대가 오면 닫힘, 30초 뒤 만료, 결정 87). 다시 연 패널이 취소 버튼·자동 입장을 되살림 |
| DELETE | `/api/rooms/requests/{friendId}` | → 204. 보낸 합류 요청 취소 (`watch:cancel`). 친구가 아니면 404. 다시 요청할 때의 30초 제한은 그대로 |
| GET | `/api/rooms/requests/outgoing` | → `{ friendId, expiresInMs }[]`. `GET /api/rooms/requests`와 같은 목록에 남은 시간 (다시 연 패널의 요청 안내 바) |
| GET | `/api/rooms/requests/incoming` | → `(UserSummary & { expiresInMs })[]`. 친구가 나에게 보내 아직 열린 합류 요청과 남은 시간 (응답·취소·무시되면 닫힘, 30초 뒤 만료(결정 87), 그 뒤의 초대는 응답이 아님, 친구가 아니게 되면 제외). 패널이 닫힌 동안 온 요청도 다시 연 패널이 보여 줌 |
| DELETE | `/api/rooms/requests/incoming/{friendId}` | → 204. 받은 합류 요청 무시: 다시 나오지 않고 이후의 초대는 그 응답으로 치지 않음. 요청한 사람에게 `watch:decline`(열린 요청이 있을 때 한 번) |
| POST | `/api/rooms/join` | `{ code }` → `RoomView`. 방 코드(대소문자·`-` 무시)를 아는 누구나 MEMBER로 입장, 이미 멤버면 그대로(결정 77). 없는 코드·기존 멤버와 차단 관계 404, 8명 가득 409, 사용자당 분당 10번 초과 429. 새로 들어오면 기존 멤버에게 `room:update` |
| GET | `/api/rooms` | 내가 멤버인 방 `RoomView[]` (초대받은 방 포함) |
| GET | `/api/rooms/{id}` | `RoomView` `{ id, content, members: [{ user, role, present }], createdAt, unread, muted, code }` (`code` = 방 코드 8자, 결정 77) |
| GET | `/api/rooms/{id}/messages?before=` | 채팅 100개 `ChatMessage[]`(방 기록 `kind` 줄 포함, 결정 78), 오래된 순: 최근 것, 또는 메시지 ID `before`보다 앞 (`createdAt`, `id` 순). 멤버가 아니거나 `before`가 이 방 메시지가 아니면 404 |
| DELETE | `/api/rooms/{id}/members/{userId}` | 204. 호스트만(403), 자기 자신 400, 멤버 아님 404. 내보내기(결정 79): 멤버십 삭제, 그 사람의 연결을 방에서 뺌, 방 코드 재입장 금지(호스트 초대로 풀림). `chat:log` `kick`, 기존 멤버 전원(내보낸 사람 포함)에게 `room:update` |
| POST | `/api/rooms/{id}/host` | `{ userId }` → 204. 호스트만(403), 자기 자신 400, 멤버 아님 404. 호스트 넘기기(결정 79): 역할 교환, `chat:log` `host`, 모든 멤버에게 `room:update` |
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
