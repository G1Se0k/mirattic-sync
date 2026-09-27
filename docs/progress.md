# Current Phase
Phase 1 — Account / Friend / Presence (완료, 2026-09-28)

이전: Phase 0 — Repository & Architecture (완료, 커밋 `300eb5f`)
저장소: https://github.com/G1Se0k/mirattic-sync (private)

## Completed
### Phase 1
- **Server**
  - Flyway V2: `users`, `refresh_tokens`, `friendships`(방향 무관 쌍 unique 함수 인덱스), `blocks`
  - 인증: signup / login / refresh / logout
    - BCrypt(DelegatingPasswordEncoder), HS256 JWT access 15분
    - refresh 30일, SHA-256 해시만 저장, rotation + 재사용 감지 시 family 전체 폐기
    - 비관적 락으로 동시 refresh 경쟁 방지
    - 없는 이메일도 더미 해시로 비교 (응답 시간으로 가입 여부를 알 수 없게)
  - Spring Security resource server(JWT), stateless, CORS는 `app.allowed-origins`만 허용
  - `/api/auth/**` IP당 분당 20회 제한 (`AuthRateLimitFilter`)
  - 친구: 요청 / 수락 / 거절·취소 / 삭제. 서로 요청하면 자동 수락. 차단하면 친구 관계와 요청 삭제
  - 사용자 검색은 정확한 이메일 일치만
  - 공개 범위 설정 `PUT /api/me/privacy` (기본 presence=FRIENDS, position=ROOM_ONLY)
  - WebSocket: 일회용 ticket handshake, raw WS
    - `SocketHub`: 사용자별 다중 세션, `ConcurrentWebSocketSessionDecorator`
    - 메모리 presence, 친구에게만 fan-out
    - `friend:update` 알림, payload Bean Validation(https URL만)
- **packages/types**: REST DTO 추가 (UserSummary, Me, AuthTokens, PresenceView, FriendView, FriendRequests)
- **packages/client** (신규): `createApi`(single-flight refresh, 401 시 1회 재시도), `connectSocket`(요청마다 새 ticket, backoff 재연결)
- **Desktop**
  - refresh token은 OS 키체인에 저장 (Rust `keyring` crate, `refresh_token_load/save` 명령)
  - 브라우저 dev 모드에서는 sessionStorage 사용
  - 화면: 로그인/가입, 친구 목록(실시간 presence), 요청 수락/거절, 이메일로 친구 추가, 삭제/차단/차단 해제, 공개 범위
  - CSP `connect-src`에 localhost:8080(http/ws) 추가
- 문서: `docs/protocol/rest.md`(신규), `docs/protocol/websocket.md`(Phase 1 확정), README 환경변수

### Phase 0
- monorepo, `packages/types`, Tauri desktop shell, WXT extension shell (side panel), Spring Boot 4 server (Maven), CI, docker-compose

### Phase 1 추가 — UID / Identity 분리
- Flyway V3: `user_identities` 테이블 생성
  - 기존 users의 email / password_hash를 LOCAL identity로 옮긴 뒤 users에서 해당 컬럼 삭제
  - 기존 로컬 DB로 검증함: UID 유지, 로그인 / 친구 / 검색 정상
- `User`는 UID + 프로필 + 설정만 가짐. `UserIdentity`(provider, subject, email?, passwordHash?) 추가, `IdentityProvider { LOCAL }`
- `/api/me` 응답에 `providers` 추가, `email`은 선택 필드
- 설계: `docs/architecture/plan.md` "사용자 식별 (UID + Identity)"

### Phase 1 추가 — 친구 코드
- Flyway V4: `users.friend_code CHAR(8) UNIQUE`, 기존 사용자에게도 발급 (로컬 DB로 검증함)
- `POST /api/friends/requests { friendCode }` → 받은 사람 `UserSummary`
  - 없는 코드와 차단 관계는 둘 다 404 (차단 여부 노출 방지)
- `POST /api/me/friend-code`로 재발급. 이메일 검색 API는 삭제
- Desktop: "내 친구 코드" (복사, 확인 창을 거친 재발급), 코드 입력으로 친구 추가

## Major Files Changed (Phase 1)
- `server/src/main/java/com/mirattic/sync/{auth,user,friend,presence,ws,config}/`
- `server/src/main/resources/{application.properties,db/migration/V2__users_friends.sql}`
- `server/src/test/java/com/mirattic/sync/{IntegrationTest.java,auth/,friend/,presence/}`
- `packages/types/src/index.ts`, `packages/client/src/{api.ts,socket.ts,api.test.ts}`
- `apps/desktop/src/{App,Login,Home,Privacy}.tsx`, `apps/desktop/src/session.ts`
- `apps/desktop/src-tauri/{src/lib.rs,Cargo.toml,tauri.conf.json}`

## Architecture Decisions
- `docs/architecture/plan.md` 결정 1–11 유지
- 12. ID는 앱에서 생성한 UUID 문자열 (`VARCHAR(36)`). TS 타입의 `string` id와 일치
- 13. 친구 요청과 친구 관계를 `friendships` 한 테이블(status)로 관리
- 14. 친구 관계 변경은 `friend:update`(payload 없음)만 보내고 클라이언트가 다시 조회. 변경 내용을 이벤트로 동기화하지 않음
- 15. Presence 공개 규칙은 순수 함수 `PresenceService.view`에 모음. 차단하면 친구 관계가 삭제되는 것으로 차단자에게 presence가 가지 않음을 보장
- 16. Desktop 상태 관리는 React state만 사용. Zustand / TanStack Query는 아직 필요 없어 도입하지 않음
- 17. JWT 라이브러리를 따로 쓰지 않고 Spring Security OAuth2 resource server에 포함된 Nimbus 사용
- 20. 친구 추가는 친구 코드로만 (이메일 검색 제거)
- 19. 사용자는 UID(`users.id`)로만 식별하고, 로그인 수단은 `user_identities`로 분리 (OAuth 대비)
- 18. MySQL은 FK `ON DELETE CASCADE` 컬럼에 CHECK를 허용하지 않아, 자기 자신 대상 요청/차단 금지는 서비스 계층에서 검증

## Tests
- `./mvnw test` ✅ 23/23 (Testcontainers MySQL 8.4)
  - AuthFlowTest 6: 비공개 기본값, 대소문자 무시 이메일 중복, 비밀번호 검사, rotation + 재사용 시 family 폐기, logout, 입력 검증
  - FriendFlowTest 7 (코드 입력 정규화, 없는 코드, 재발급 포함): 요청/수락/삭제, 상호 요청, 받은 사람만 수락, 차단(양방향 요청 불가, 검색 숨김), 자기 자신
  - PresenceViewTest 4: 공개 규칙
  - PresenceSocketTest 4: 친구에게만 전달, client가 보낸 userId 무시, 위치 제거, 차단 후 전달 안 됨, 잘못된 payload, ticket 일회성
  - ServerApplicationTests 2
- `packages/client` vitest ✅ 3/3 (동시 refresh 1회, refresh 거부 시 토큰 삭제, problem detail)
- `pnpm typecheck` / `pnpm build` ✅, `cargo check` ✅
- 수동 E2E(Playwright, 브라우저 dev 모드 탭 2개)
  - 가입 → 이메일로 친구 요청 → 상대 화면에 실시간 표시 → 수락 → 온라인 표시 → 탭 닫으면 오프라인 → 새로고침해도 세션 유지 ✅

## Known Issues
- **Tauri 앱에서 키체인 경로를 실제로 실행해 보지 않음** (cargo check만 함). 첫 `tauri dev` 때 macOS 키체인 접근 허용 창이 뜰 수 있음
- CSP / `VITE_API_URL`이 localhost 고정 → 배포(Phase 10)에서 운영 주소로 바꿔야 함
- Presence, WS ticket, rate limit 카운터가 서버 메모리에 있음 → 서버 1대 전제 (`ponytail:` 주석)
- rate limit은 소켓 주소 기준 → 프록시 뒤에서는 `server.forward-headers-strategy` 설정 필요
- WebSocket presence 전송 제한(250ms)은 초과분을 버림 → adapter가 상태 변화가 있을 때만 보내야 함
- `IN_ROOM`, `DND` 상태는 아직 없음 (Phase 2 / 5)
- 계정 삭제, 신고 없음 (Phase 9)
- 이메일 인증, 비밀번호 재설정 없음
- OAuth 미구현. 추가 시 `email_verified`, 명시적 계정 연결, 마지막 identity 삭제 금지 필요 (plan.md)
- 친구 코드 생성 시 충돌을 재시도하지 않음 (unique 제약에만 의존, 수백만 명 이하에서는 무시할 수준)
- 친구 요청 API에 사용자별 rate limit 없음 → 코드 무차별 대입은 코드 공간(8.5×10¹¹)에만 의존. 공개 서비스 전에 요청 제한 추가 필요
- Windows 빌드 미검증 (CI에 Tauri 빌드 매트릭스 없음). CI(web + server)는 GitHub에서 통과함
- Extension 로그인은 아직 없음 (Phase 3). 서버 `ALLOWED_ORIGINS`에 extension origin 추가 필요

## Next Task
Phase 2 — Mock Media Provider + 동기화 엔진
1. `packages/sync-core` 생성 (순수 TS + vitest)
   - `estimatePosition(state, nowServer)`, 시계 offset 추정(`sync:request/response`, RTT/2)
   - drift 정책 (`DEFAULT_DRIFT` + provider override) → `ignore | recheck | seek | immediate`
   - version 필터 (작거나 같은 version 버림), echo 억제 (프로그램 조작 직후 이벤트 무시)
   - `MockMediaProvider` (`MediaProviderAdapter` 구현, 가짜 시계로 재생)
2. 서버
   - Flyway V3 `rooms`, `room_members`
   - `POST /api/rooms`(친구 초대), `room:join/leave/invite`
   - host만 `playback:*` 가능, room별 version 증가, `playback:update` 브로드캐스트, `sync:request/response`
   - 테스트: 멤버가 아니면 거부, host가 아니면 거부, version 단조 증가
3. Desktop: mock player 화면 (방 만들기 / 참가, 재생 / 일시정지 / seek 버튼, drift 표시)으로 두 클라이언트 동기화 확인
