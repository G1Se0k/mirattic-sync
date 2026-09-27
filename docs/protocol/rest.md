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
| GET | `/api/me` | `Me` |
| PUT | `/api/me/privacy` | `{ presenceVisibility, positionVisibility }` → `Me` |
| GET | `/api/users/search?email=` | 정확히 일치하는 이메일만. 자기 자신 / 차단 관계는 제외 → `UserSummary[]` |

## Friends / Blocks

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/friends` | `FriendView[]` (presence 포함, 공개 규칙 적용) |
| GET | `/api/friends/requests` | `{ incoming, outgoing }` |
| POST | `/api/friends/requests` | `{ userId }`. 상대가 이미 요청했으면 즉시 친구. 차단 관계 / 중복이면 409 |
| POST | `/api/friends/requests/{id}/accept` | 받은 사람만 가능, 아니면 404 |
| DELETE | `/api/friends/requests/{id}` | 거절(받은 사람) 또는 취소(보낸 사람) |
| DELETE | `/api/friends/{userId}` | 친구 삭제 |
| GET | `/api/blocks` | 차단 목록 |
| PUT | `/api/blocks/{userId}` | 차단. 친구 관계와 대기 중인 요청을 삭제 |
| DELETE | `/api/blocks/{userId}` | 차단 해제 |
| POST | `/api/ws-ticket` | `{ ticket }` |
