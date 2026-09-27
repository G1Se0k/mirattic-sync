# Current Phase
Phase 2 — Mock Media Provider + 동기화 엔진 (완료, 2026-09-28, 미커밋)

이전: Phase 1 — Account / Friend / Presence (완료, 커밋 `c4494fe`), Phase 0 (커밋 `300eb5f`)
저장소: https://github.com/G1Se0k/mirattic-sync (private)

## Completed
### Phase 2
- **packages/sync-core** (신규, 순수 TS)
  - `ServerClock`: `sync:request/response`로 서버 시계 offset 추정 (RTT/2, 최근 8개 중 RTT 최소 샘플)
  - `estimatePosition`, `classifyDrift` (`DEFAULT_DRIFT` + provider override)
  - `SyncFollower`: version 필터, 재생 상태 즉시 맞춤, drift 정책, seek 구간 재확인, 광고 중 보류
  - `publishHost`: 호스트 플레이어 변경 → `playback:play|pause|seek` (200ms 단위로 모음)
  - `MockMediaProvider`: 시계로 위치를 계산하는 가짜 플레이어 (`MediaProviderAdapter` 구현)
- **packages/types**: `"mock"` provider, `RoomContent`, `RoomView`, `RoomMemberView`, `RoomRole`, `PlaybackCommand`
- **Server**
  - Flyway V5 `rooms`(콘텐츠 + 최신 playback + version), `room_members`(HOST/MEMBER)
  - REST `/api/rooms` 생성(친구만 초대) / 목록 / 조회 / 나가기(HOST면 방 삭제)
  - WS `room:join/leave`, `playback:play/pause/seek`(HOST만, 행 잠금으로 version 증가), `playback:update`, `room:invite`, `room:update`, `sync:request/response`
  - 멤버가 나가면 그 사용자의 연결을 방에서 즉시 제거 (재생 이벤트 차단)
- **packages/client**: `createRoom`, `rooms`, `room`, `leaveRoom`
- **Desktop**
  - 친구 목록에 "같이 보기" (Mock 콘텐츠로 방 생성 + 친구 초대), "방" 목록 (입장 / 나가기 / 닫기)
  - `Room.tsx`: Mock 플레이어, 호스트 조작(재생·일시정지·±10초), 멤버 동기화 상태·마지막 보정 표시, 어긋나게 하기 버튼(+0.8 / −2 / −5초)
  - 재연결 시 `room:join`과 시계 측정을 다시 함

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

## Major Files Changed (Phase 2)
- `packages/sync-core/src/{clock,mock,sync,index}.ts`, `sync.test.ts`
- `packages/types/src/index.ts`, `packages/client/src/api.ts`
- `server/src/main/java/com/mirattic/sync/room/` (신규), `ws/{SocketHandler,SocketHub}.java`, `presence/MediaProvider.java`
- `server/src/main/resources/db/migration/V5__rooms.sql`
- `server/src/test/java/com/mirattic/sync/{IntegrationTest.java,room/RoomFlowTest.java}` (WS 테스트 도우미를 IntegrationTest로 이동)
- `apps/desktop/src/{Room.tsx,Home.tsx,format.ts}`

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
- 21–28 (Phase 2): mock provider, playback/version DB 저장, 초대=멤버십, `room:update` 후 재조회, 서버 시각 기준 `capturedAt`, seek 구간 재확인, echo 억제 창 없음, 호스트 명령 모으기 + 초당 제한 — `plan.md` 참고
- 18. MySQL은 FK `ON DELETE CASCADE` 컬럼에 CHECK를 허용하지 않아, 자기 자신 대상 요청/차단 금지는 서비스 계층에서 검증

## Tests
- `./mvnw test` ✅ 31/31 (Testcontainers MySQL 8.4)
  - SocketHubTest 2: 멤버십 확인 중 나가기가 끼어들어도 등록이 남지 않음(수정을 되돌리면 실패 확인), 확인 실패 시 등록 안 함
  - RoomFlowTest 6: 친구만 초대 / 비멤버에게 404, 비멤버 join·조작 거부(`not_member`), 멤버 조작 거부(`not_host`), version 1→2→3 · capturedAt 보정 · duration 제한, 초당 제한, 나간 멤버에게 이벤트 안 감 · HOST 나가면 방 삭제, `sync:response`
- `packages/sync-core` vitest ✅ 11/11 (가짜 타이머)
  - 시계 offset(최소 RTT), 위치 추정, drift 구간, 시계가 5초 어긋난 멤버의 참가 위치, 오래된 version 버림, 무시/재확인/확인 후 seek/즉시 seek, 호스트 이벤트 직후 즉시 보정, 일시정지·광고, 호스트→서버→멤버 전체 흐름(연속 조작 모으기 포함)
  - 확인: 재확인 로직과 version 필터를 일부러 망가뜨리면 테스트가 실패함
- Codex 검증 1차 FAIL (2026-09-28, 검사 5개는 모두 통과, 리뷰에서 blocking 2개) → 수정
  - 평가 도중 새 상태가 오면 "호스트 이벤트" 표시가 사라져 1.5~3초 차이를 즉시 보정하지 않음 → 대기 중인 재확인에 표시 유지, 교체된 평가는 중단. 회귀 테스트 추가(수정을 되돌리면 실패 확인)
  - 호스트가 연결 끊긴 동안 조작하면 재연결 후에도 멤버에 반영되지 않음 → 연결 중에만 publish, 재연결 시 publisher를 다시 시작해 현재 상태 전송. sync-core에 재시작 테스트 추가 (desktop은 테스트 도구가 없어 Room.tsx 연결 부분은 수동 확인 대상)
  - (non-blocking) 방 나가기 실패를 무시하던 것 → 404 외 실패는 알리고 화면 유지
- Codex 재검증 1회차 FAIL (blocking 1개) → 수정
  - `room:join`의 멤버십 확인과 소켓 등록 사이에 REST 나가기가 끼면, 나간 사용자가 계속 재생 이벤트를 받을 수 있음 → 확인과 등록을 SocketHub의 방 단위 원자 연산(`ConcurrentHashMap.compute`) 안에서 수행, 나가기/닫기 제거와 직렬화
- Codex 재검증 2회차 FAIL → 판단
  - 거부: "drift 정확히 1500ms가 recheck" → CLAUDE.md 정책(`500-1500ms re-check`, `> 1500ms seek`)과 일치
  - 거부(설계 결정): "`room:leave`가 멤버십 확인 안 함" → 자기 연결만 빼는 멱등 동작, websocket.md에 이유 기록
  - 수정(non-blocking): 방 불러오기가 404 외 오류일 때 로딩에서 멈춤 → 오류 표시 + 다시 시도
- 수동 E2E (Playwright, 브라우저 dev 모드 탭 2개, 2026-09-28)
  - 같이 보기 → 초대받은 쪽 "방" 목록에 실시간 표시 → 입장 → 참가 표시
  - 호스트 재생 / +10초 / 일시정지가 멤버에 반영, 차이 ±20ms 이내
  - 멤버 +0.8초: 허용 · −2초: 1초 뒤 확인 후 보정 · −5초: 즉시 보정
  - 방 닫기 → 멤버 화면이 친구 목록으로 돌아가고 안내 표시
  - **발견 후 수정**: "재생" 직후 "+10초"를 누르면 서버 최소 간격 제한(100ms)에 seek가 버려져 멤버가 계속 10초 어긋남 → 결정 28로 수정 후 재확인
- 서버 재시작 중 클라이언트 재연결 backoff 동작 확인

### Phase 1 Tests
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
- `IN_ROOM`, `DND` 상태는 아직 없음 (Phase 5)
- **Phase 2**
  - 방 안에서의 `positionVisibility=ROOM_ONLY` 규칙은 따로 적용하지 않음 (방 멤버는 재생 상태를 받음. presence 위치는 여전히 친구에게 숨김)
  - 차단해도 기존 방 멤버십은 남음 → Phase 5(같이 보기)에서 차단 시 공통 방 정리 필요
  - `playback:content-change` 없음 (Phase 4)
  - 호스트 위임 없음. 호스트가 나가면 방이 닫힘
  - 방 참가(present) 상태가 서버 메모리에 있음 (서버 1대 전제)
  - 멤버가 로컬에서 조작해도 호스트 상태로 되돌림 (호스트 권한 모델). 실제 플레이어에서 사용자가 불편할 수 있음 → Phase 4에서 확인
  - desktop 앱에 테스트 스크립트 없음, lint는 전 패키지에 없음 (Codex 보고)
  - 실제 플레이어는 seek 후 위치가 부정확하고 `seeking` 중 이벤트가 섞일 수 있음. Mock에서는 검증 불가 → Phase 4에서 echo 처리 재검토
  - 시계 측정은 입장 / 재연결 시 5회만. 장시간 시청 중 시계 drift는 재측정하지 않음
  - 시계 측정 코드(`sync:request` 보내기)가 Desktop `Room.tsx`에 있음 → Extension에서 필요해지면 공용 패키지로 이동
- 계정 삭제, 신고 없음 (Phase 9)
- 이메일 인증, 비밀번호 재설정 없음
- OAuth 미구현. 추가 시 `email_verified`, 명시적 계정 연결, 마지막 identity 삭제 금지 필요 (plan.md)
- 친구 코드 생성 시 충돌을 재시도하지 않음 (unique 제약에만 의존, 수백만 명 이하에서는 무시할 수준)
- 친구 요청 API에 사용자별 rate limit 없음 → 코드 무차별 대입은 코드 공간(8.5×10¹¹)에만 의존. 공개 서비스 전에 요청 제한 추가 필요
- Windows 빌드 미검증 (CI에 Tauri 빌드 매트릭스 없음). CI(web + server)는 GitHub에서 통과함
- Extension 로그인은 아직 없음 (Phase 3). 서버 `ALLOWED_ORIGINS`에 extension origin 추가 필요

## Next Task
Phase 3 — Extension Base
1. 정책 확인: Chrome Web Store 사용자 데이터 정책 → `docs/platform-policy/chrome-web-store.md` (확인 날짜 기록)
2. Extension 로그인 (별도 로그인, refresh token은 `chrome.storage.session` 또는 `local` — 정책 확인 후 결정)
   - 서버 `ALLOWED_ORIGINS`에 `chrome-extension://<id>` 추가, 고정 extension key로 ID 고정
3. background service worker에서 `connectSocket` (MV3 service worker 수명 문제 확인: side panel이 열려 있을 때 연결 유지)
4. provider registry (`providers/` 폴더, 현재 탭 URL로 adapter 선택), content script ↔ background 메시지
5. side panel: 로그인 상태, 친구 presence, 방 목록 / 입장, MockMediaProvider로 방 동기화 (content script 없이)
6. 시계 측정 코드를 `packages/client` 또는 `sync-core`로 이동해 Desktop과 공유
