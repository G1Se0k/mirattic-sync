# Architecture Plan (승인: 2026-09-28)

원 기획: `Mirattic_Sync_PLAN.md`. 이 문서는 승인된 결정만 기록한다.

## 결정 사항

| # | 결정 | 이유 |
|---|---|---|
| 1 | pnpm workspace, Turborepo 없음 | `pnpm -r`로 충분 |
| 2 | Extension은 WXT | MV3의 content script(IIFE) / service worker(ESM) 분리 빌드를 대신 처리 |
| 3 | Chat Panel은 Chrome `sidePanel` API | 페이지 DOM에 삽입하지 않으므로 플레이어를 가리지 않음이 구조적으로 보장됨. Edge도 지원 |
| 4 | Raw WebSocket + JSON envelope (STOMP 없음) | CLAUDE.md 이벤트 이름과 일치, 클라이언트 라이브러리 불필요 |
| 5 | JWT access + DB refresh token rotation, bearer only (쿠키 없음) | Desktop/Extension은 쿠키 origin 처리가 번거로움. 쿠키가 없으므로 CSRF 비적용 |
| 6 | WebSocket 인증은 일회용 ticket (`POST /api/ws-ticket` → `?ticket=`, 30초) | access token이 URL/로그에 남지 않도록 |
| 7 | Extension ↔ Desktop은 Backend 경유 (A안) | native messaging host 설치/localhost origin 문제 회피. 같이 보기는 Tauri opener로 canonicalUrl 오픈 |
| 8 | 서버 빌드는 Maven | 2026-09-28 기준 start.spring.io의 Gradle 생성이 모두 500 에러. Gradle을 쓸 특별한 이유 없음 |
| 9 | `api-client` / `websocket-client` / `ui` 패키지는 필요해질 때 생성 | Phase 1에서 `packages/client` 하나로 시작 |
| 10 | Presence는 서버 메모리에만 (UserPresence 테이블 없음) | 휘발성 데이터. 다중 인스턴스 시 Redis pub/sub |
| 11 | 시간 값은 전부 epoch ms (`ChatMessage.createdAt` 포함) | CLAUDE.md 규칙. 기획서의 string createdAt 대체 |
| 12 | ID는 앱에서 생성한 UUID 문자열 (`VARCHAR(36)`) | TS의 string id와 일치 (Phase 1) |
| 13 | 친구 요청과 친구 관계를 `friendships` 한 테이블(status)로 관리 | 방향 무관 쌍 unique 함수 인덱스로 중복 방지 |
| 14 | 친구 관계 변경은 `friend:update`만 보내고 클라이언트가 다시 조회 | 변경 내용 동기화 로직이 필요 없음 |
| 15 | Presence 공개 규칙은 순수 함수 `PresenceService.view` 하나에 모음 | 테스트 가능. 차단 = 친구 관계 삭제 |
| 16 | Desktop은 React state만 사용 (Zustand / TanStack Query 보류) | 아직 필요 없음 |
| 17 | JWT는 Spring Security에 포함된 Nimbus 사용 | 추가 의존성 없음 |
| 18 | Desktop refresh token은 OS 키체인 (`keyring` crate) | webview 저장소에 장기 토큰을 두지 않음 |
| 19 | 사용자는 UID(`users.id`)로만 식별하고, 로그인 수단은 `user_identities`로 분리 | OAuth 대비. 아래 참고 |
| 20 | 친구 추가는 친구 코드로만 (이메일 검색 제거), 재발급 가능 | 이메일 가입 여부 노출 방지, 이메일 없는 OAuth 사용자 지원 |
| 21 | `MediaProvider`에 `"mock"` 추가 | MockMediaProvider도 같은 adapter 인터페이스와 서버 검증을 그대로 통과해야 함 |
| 22 | 방 playback 상태와 version은 DB(`rooms` 행)에 저장, 명령마다 행 잠금 | 서버 재시작 후에도 version이 줄지 않아야 클라이언트가 새 상태를 버리지 않음 |
| 23 | 초대 = 멤버십 부여 (수락 단계 없음). 방 참가 여부(present)는 서버 메모리 | 친구끼리의 비공개 방이라 충분. 참가 여부는 휘발성 |
| 24 | 방 변경은 `room:update`만 보내고 클라이언트가 다시 조회 | 결정 14와 같은 패턴 |
| 25 | 호스트 명령의 `capturedAt`은 호스트가 추정한 서버 시각 | 멤버마다 시계가 달라도 서버 시각 하나로 위치를 추정 |
| 26 | drift의 seek 구간(1.5–3초)은 한 번 더 확인한 뒤 보정, 호스트 이벤트 직후에는 즉시 | 버퍼링 같은 일시적 차이로 불필요한 seek를 하지 않기 위해 |
| 27 | echo 억제 창 없음 | MVP는 멤버가 명령을 보내지 않으므로, 보정 후 발생한 이벤트는 재확인에서 차이 0으로 끝남 |
| 28 | 호스트 명령은 클라이언트에서 200ms 단위로 모으고, 서버는 초당 20회 제한 | 최소 간격 제한은 지터로 붙은 마지막 명령을 버려 멤버가 계속 어긋남 (E2E에서 발견) |

## 사용자 식별 (UID + Identity)

- `users.id` = UID. 앱에서 생성한 UUID이며 이메일이나 provider ID에서 파생하지 않는다. JWT `sub`, 모든 FK, WebSocket `userId`는 UID만 쓴다.
- `user_identities(provider, subject)` 쌍은 전역 unique. 한 사용자가 여러 identity를 가질 수 있다.
  - `LOCAL`: subject = 정규화된 이메일, `password_hash` 있음
  - OAuth(예정): subject = provider의 고정 subject ID (이메일이 아님, 이메일은 바뀔 수 있음). `password_hash`는 null
- `email` 컬럼은 연락처용이며 null일 수 있다 (Apple 비공개 릴레이 등). 친구 검색에는 쓰지 않는다 (친구 코드 사용).
- **OAuth 추가 시 결정할 것**
  - provider enum 값 추가, `email_verified` 컬럼 추가
  - 계정 연결 정책: 로그인한 상태에서 명시적으로 연결하는 것을 기본으로 한다. 같은 이메일이라고 자동 연결하지 않는다 (검증되지 않은 이메일로 계정을 탈취할 수 있음)
  - 마지막 identity 삭제 금지

## MediaProviderAdapter

adapter는 `sourceUserId`/`version`을 알 수 없으므로 로컬 `PlayerSnapshot`만 반환하고, room 계층이 `PlaybackState`로 감싼다.
정의: `packages/types/src/index.ts`.

## Backend 도메인 (Phase 1–4)

- `User` — email, passwordHash(BCrypt), displayName, presenceVisibility(기본 FRIENDS), positionVisibility(기본 ROOM_ONLY)
- `RefreshToken` — tokenHash, userId, familyId, expiresAt, revokedAt
- `Friendship` — requesterId, addresseeId, status(PENDING/ACCEPTED). FriendRequest와 통합
- `Block` — blockerId, blockedId
- `Room` — ownerId, visibility, provider, contentId, canonicalUrl, 최신 playback(positionMs, playing, capturedAt, version)
- `RoomMember` — roomId, userId, role(HOST/MEMBER), joinedAt
- `ChatMessage` — roomId, userId, text, mediaPositionMs?, createdAt

나중: `Reaction`(Phase 8), `Notification`(Phase 5).

## 알려진 기술 위험

1. 클라이언트 간 시계 차이 → `sync:request/response`로 서버 시계 offset 추정 (RTT/2)
2. echo loop (프로그램 seek이 이벤트를 다시 발생) → sync-core에서 억제 창. MVP는 host만 전파
3. Autoplay 정책 → 방 참가 시 "동기화 시작" 클릭으로 사용자 동작 확보
4. YouTube 광고 → adapter가 `adPlaying` 노출, 광고 중 sync 일시중지
5. Netflix는 `video.currentTime` 직접 변경 시 오류가 알려져 있음 → Phase 6 정책 검토 시 결정
6. Extension 로그인 → MVP는 extension에서 별도 로그인
7. Chrome Web Store 사용자 데이터 정책 (시청 기록 = 브라우징 활동) → 개인정보처리방침, 최소 host_permissions

## 정책 확인 (각 provider 작업 직전, `docs/platform-policy/`에 날짜와 함께)

- Chrome Web Store 정책 — Phase 3 시작 시
- YouTube (youtube.com 페이지의 `<video>` 제어가 API ToS 대상인지 불확실) — Phase 4 시작 시
- Netflix 이용약관 — Phase 6
- Laftel 이용약관 / 동시 재생 제한 — Phase 7
