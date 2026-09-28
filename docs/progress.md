# Current Phase
Phase 4 — YouTube + Chat (완료, 2026-09-28)

이전: Phase 3 (커밋 `6651a72`), Phase 2 (커밋 `104fdc4`), Phase 1 (커밋 `c4494fe`), Phase 0 (커밋 `300eb5f`)
저장소: https://github.com/G1Se0k/mirattic-sync (private)

## Completed
### Phase 4
- 정책 확인: `docs/platform-policy/youtube.md` (2026-09-28). 약관 해석이 불확실한 부분은 보수적으로 구현하고 스토어 공개 전 재검토로 기록
- **Extension**
  - 처음 사용 시 공개·동의 화면 (`Consent.tsx`). 동의 전에는 YouTube 탭에 연결하지 않음
  - YouTube content script (`https://www.youtube.com/*`만) + `providers/youtube.ts` adapter
    - 영상 ID(URL), 제목(탭 제목), `<video>` 재생 상태만 읽음. 선택자는 이 파일에만
    - 광고 중(`#movie_player.ad-showing`)에는 play/pause/seek 무시
  - `bridge.ts`: side panel ⇄ content script port. side panel 쪽은 `MediaProviderAdapter`로 보임
  - side panel이 이 창의 YouTube 탭을 따라가며 room player / 지금 보는 영상 / presence로 사용 (`watch.ts`)
  - presence: 시청 중인 영상을 친구에게 (공개 범위 규칙 그대로), 300ms 모아서 전송
  - host_permissions `https://www.youtube.com/*` 추가 (content script와 같은 범위)
- **packages/ui**
  - `configure(api, socketUrl, platform)`: 앱별 adapter / 지금 보는 영상 / presence / 페이지 열기
  - "같이 보기"는 지금 보는 YouTube 영상으로 방 생성 (없으면 Mock)
  - Room: YouTube 방은 탭 상태 표시, 다른 영상이면 "YouTube에서 이 영상 열기"(누를 때만 이동)
  - 호스트 탭의 영상이 바뀌면 `playback:content-change`로 방도 따라감
  - **채팅** (`Chat.tsx`): 보낼 때 내 재생 위치 첨부, 호스트는 타임스탬프를 누르면 확인 후 모두 이동, 멤버는 표시만
- **Desktop**: YouTube 방은 안내 + 기본 브라우저로 열기 (Tauri opener)
- **sync-core**: `publishHost`는 광고 중 스냅샷을 보내지 않음
- **types**: `watchUrl` (provider + contentId로 URL 생성)
- **Server**
  - WS `playback:content-change` (호스트만, 0초·일시정지로 초기화 + version 증가)
  - YouTube contentId 형식 검증 (방 생성, content-change)
  - 채팅: Flyway V6 `chat_messages`, WS `chat:message`(멤버만, 1–1000자, 초당 5회), `GET /api/rooms/{id}/messages`
  - WS의 400은 `bad_payload`로 응답 (전에는 `not_member`)
- 결정 33–40 (`plan.md`)

### Phase 3
- 정책 확인: `docs/platform-policy/chrome-web-store.md` (2026-09-28)
- **packages/ui** (신규): Desktop 화면(Login / Home / Room / Privacy, CSS)을 옮겨 Desktop과 Extension이 공유
  - 각 앱은 토큰 저장소만 다른 API client를 `configure(api, socketUrl)`로 넘김
  - 시계 측정 코드(Room.tsx)도 함께 공유됨
- **Extension**
  - side panel = 같은 앱 (로그인, 친구 presence, 친구 코드, 방 목록 / 입장, Mock 동기화)
  - refresh token은 `chrome.storage.session` (브라우저 재시작 시 재로그인), access token은 메모리
  - API client / WebSocket은 side panel 페이지가 가짐 (결정 29)
  - 권한 `sidePanel`, `storage`만. 목적 없던 YouTube content script 셸 삭제 (Phase 4에서 adapter와 함께 추가)
  - manifest `key`로 dev ID `kphihploboaigagpahhdhjiaglnfmpii` 고정
- **Server**: `ALLOWED_ORIGINS` 기본값에 dev extension origin 추가
- `sync-core/clock.ts`: Extension의 `noUncheckedIndexedAccess`에서 걸린 타입 오류 수정 (동작 변화 없음)
- 결정 29–32 (`plan.md`)

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

## Major Files Changed (Phase 4)
- `apps/extension/{bridge.ts,providers/youtube.ts,wxt.config.ts}`, `entrypoints/youtube.content.ts`, `entrypoints/sidepanel/{main.tsx,Consent.tsx,watch.ts}`
- `packages/ui/src/{session.ts,index.ts,Home.tsx,Room.tsx,Chat.tsx,format.ts,App.css}`, `apps/desktop/src/main.tsx`
- `packages/sync-core/src/{sync.ts,sync.test.ts}`, `packages/types/src/index.ts`, `packages/client/src/api.ts`
- `server/.../room/{RoomService,RoomController,Room,ChatMessage,ChatMessageRepository}.java`, `ws/SocketHandler.java`, `db/migration/V6__chat_messages.sql`, `RoomFlowTest.java`
- `docs/platform-policy/{youtube.md,chrome-web-store.md}`, `docs/protocol/{websocket,rest}.md`, `docs/architecture/plan.md`

## Major Files Changed (Phase 3)
- `packages/ui/` (신규, `apps/desktop/src/*.tsx`에서 이동), `apps/desktop/src/main.tsx`
- `apps/extension/{wxt.config.ts,package.json}`, `entrypoints/sidepanel/{main.tsx,session.ts}`, `entrypoints/youtube.content.ts` 삭제
- `server/src/main/resources/application.properties`
- `docs/platform-policy/chrome-web-store.md`, `docs/architecture/plan.md`, `README.md`

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
- 33–40 (Phase 4): YouTube는 사용자 탭의 `<video>` 제어, URL은 contentId로 생성, content-change, 광고 중 명령 없음, 동의 화면, Platform 주입, side panel ⇄ content script port, 채팅 저장 — `plan.md` 참고
- 29–32 (Phase 3): Extension은 side panel이 소켓 소유, refresh token은 `storage.session`, 화면은 `packages/ui` 공유, 최소 권한 — `plan.md` 참고
- 18. MySQL은 FK `ON DELETE CASCADE` 컬럼에 CHECK를 허용하지 않아, 자기 자신 대상 요청/차단 금지는 서비스 계층에서 검증

## Tests
### Phase 4
- `./mvnw test` RoomFlowTest 8/8 (추가 2: content-change 호스트만·형식 검증·0초 초기화·version, 채팅 멤버만·공백 제거·길이·위치·기록)
- `packages/sync-core` vitest 13/13 (추가: 광고 중 위치를 publish하지 않음, 보낼 때의 최신 스냅샷만 보냄. 수정을 되돌리면 실패 확인)
- `pnpm typecheck` / `pnpm build` ✅
- 수동 E2E (Playwright Chromium 2개 = 서로 다른 두 사용자, 빌드된 확장 로드, youtube.com을 가짜 페이지(무음 WAV `<video>`)로 route, 2026-09-28)
  - 동의 → 가입, `storage.local`에는 동의 키만
  - 호스트 side panel이 YouTube 탭을 인식, 멤버 친구 목록에 "YouTube · 제목 시청 중"
  - 같이 보기 → 멤버 입장 → 다른 영상이면 "이 영상 열기"로 자기 탭 이동
  - 호스트 seek·재생 → 멤버 60.2s/60.1s, 일시정지 반영
  - 호스트 광고 중 위치(3초)가 멤버에 가지 않음, 광고 후 재개
  - 멤버 광고 중 보정 안 함, 광고 후 보정
  - 호스트가 페이지 안에서 다음 영상으로 이동 → 방 제목 변경 → 멤버 "이 영상 열기" → 새 영상에서 동기화
  - 채팅: 멤버 메시지에 위치 첨부, 멤버에게는 타임스탬프 버튼 없음, 호스트 클릭 → 확인 창 → 모두 이동
  - 따라가던 탭을 닫거나 다른 사이트로 이동하면 창의 다른 YouTube 탭으로 넘어가고, 호스트 플레이어를 따라 방 영상도 바뀜
- `packages/ui` vitest 1/1 (신규 test 스크립트: 채팅 기록과 실시간 메시지 병합)
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 5개는 모두 통과, 리뷰에서 blocking 3개) → 수정
  - 200ms 창에서 대기 중이던 호스트 명령이 광고가 시작된 뒤 전송될 수 있음 → 광고 스냅샷이 오면 대기 명령 취소. 테스트 추가(수정을 되돌리면 실패 확인)
  - 따라가던 YouTube 탭을 닫으면 같은 창의 다른 YouTube 탭을 다시 찾지 않음 → 닫힐 때 다시 선택. E2E에 추가
  - 채팅 기록 응답이 그사이 받은 실시간 메시지를 덮어씀 → id로 병합 후 시간순 정렬
- Codex 재검증 1회차 FAIL (1차 지적 3개는 해결 확인, 새 blocking 3개) → 수정
  - content script가 동의 전에도 adapter를 만들어 영상 ID·광고 상태를 1초마다 읽음 → 동의한 side panel이 연결했을 때만 생성, 끊기면 정리
  - 따라가던 탭이 YouTube를 떠나면 다른 YouTube 탭을 찾지 않음 → 다시 선택 (없으면 그 탭 유지). E2E에 추가
  - 광고 시작 이벤트(1초 폴링)보다 200ms 대기 명령이 먼저 나가면 광고 중 전송 → 전송 직전 스냅샷의 광고 여부 재확인. 테스트 추가(수정을 되돌리면 실패 확인)
- Codex 재검증 2회차 FAIL (2회차 지적 3개 중 2개 해결 확인, 광고 처리를 파고든 blocking 1개) → 수정
  - 비동기 flush가 대기 중이던 이전 영상의 스냅샷을 새 영상의 content-change 뒤에 보내거나, 탭이 사라져도 보낼 수 있음
  - → `publishHost`는 변경을 "dirty" 표시만 하고, 보낼 때 읽은 최신 스냅샷을 보냄 (없거나 광고면 안 보냄, 더 새 flush가 시작됐으면 버림). 방 화면은 스냅샷의 영상이 "지금 보는 영상"과 같을 때만 보내고, 다르면 그 영상의 변경 이벤트가 다시 보내게 둠
  - 테스트 추가: 다음 영상으로 바뀐 뒤 대기 명령, 사라진 플레이어, 느린 읽기를 앞지른 flush (가드를 되돌리면 실패 확인). 전체 E2E 재실행 통과
- Codex 재검증 3회차(자동 재검증 마지막) FAIL (2회차 수정은 확인, blocking 1개)
  - 새 영상에서 첫 명령이 `seek`로 나가 content-change로 일시정지된 방이 계속 일시정지될 수 있음 (Room이 명령을 건너뛰어도 보낸 것으로 기록 + 영상이 바뀌어도 이전 재생 상태와 비교). 실제 YouTube처럼 다음 영상이 자동 재생되면 항상 발생
  - → 수정: 새 영상의 첫 명령은 항상 play/pause, `send`가 false를 반환하면 보낸 것으로 기록하지 않음. 테스트 추가(두 수정 각각 되돌리면 실패 확인), E2E 가짜 페이지를 자동 재생으로 바꿔 전체 재실행 통과
  - 자동 재검증 횟수를 다 써서 멈추고 보고 → 사용자 요청으로 추가 검증
- Codex 추가 검증 PASS (사용자 요청): sync-core 13, client 3, ui 1, typecheck, build, server verify 33 통과, 발견 사항 없음. lint 없음, desktop / extension / types에 test 스크립트 없음
- 실제 youtube.com (확장 없이 Playwright): `#movie_player video`, 탭 제목 형식, `currentTime` seek 동작 확인. 광고(`ad-showing`)는 실제로 관찰하지 못함
- Desktop dev: YouTube 방 입장 → 안내 + "YouTube에서 이 영상 열기"가 올바른 URL을 엶

### Phase 3
- `pnpm typecheck` / `pnpm build` ✅ (packages/ui 포함)
- 수동 E2E (Playwright Chromium에 빌드된 확장 로드, side panel 페이지를 360px 탭으로 열고 Desktop dev 탭과 함께, 2026-09-28)
  - service worker URL로 고정 ID 확인
  - Extension에서 가입 (extension origin CORS) → 친구 코드로 Desktop 사용자와 친구 → 온라인 presence 수신 (WS origin)
  - 새로고침 후에도 로그인 유지, refresh token이 `storage.session`에만 있고 `storage.local`은 비어 있음
  - Desktop이 호스트인 방에 Extension이 입장 → 재생 / +10초 / 일시정지 반영, 동기화됨(차이 18ms)
  - 360px 폭에서 화면 깨짐 없음
- Codex Sol 검증 1차 PASS (2026-09-28): sync-core 11, client 3, typecheck, build, server verify 31 통과, 발견 사항 없음. lint 없음, desktop / extension / types / ui에 test 스크립트 없음
- 스크립트: 저장소에 넣지 않음 (Extension 테스트 도구 도입은 Phase 4 content script와 함께 판단)

### Phase 2
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
- **Phase 4**
  - YouTube 약관상 content script 제어의 허용 여부 불확실 → 스토어 공개 전 재검토 (`youtube.md`)
  - 실제 YouTube 광고로 `ad-showing` 감지를 검증하지 못함 (가짜 페이지로만). 바뀌면 광고 중 동기화가 틀어질 수 있음
  - 개인정보처리방침 문서 없음 (동의 화면만). 스토어 제출 전 필요 (Phase 10)
  - 확장 설치 전에 열려 있던 YouTube 탭은 새로고침해야 연결됨 ("영상이 열린 탭이 없습니다"로 보임)
  - 멤버의 `video.play()`가 autoplay 정책으로 거부되면 재시도하지 않음 (사용자가 탭에서 재생해야 함)
  - 라이브, 재생 속도 변경, 프리미어는 미검증. 재생 속도는 동기화하지 않음
  - 호스트가 페이지 안에서 영상을 바꾸면 제목이 이전 영상일 수 있음 (탭 제목이 늦게 바뀜)
  - 방 화면의 YouTube 위치 표시는 1초마다 갱신
  - 채팅 신고 / 삭제 없음 (Phase 9)
  - Extension 자동 테스트 없음 (E2E 스크립트는 저장소 밖), ui는 병합 함수 테스트만, lint 없음
  - 호스트가 따라가던 탭을 닫으면 창의 다른 YouTube 탭 영상으로 방이 바뀜 (호스트 권한 모델 그대로)
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
- **Phase 3**
  - manifest `key`는 dev용. 스토어 등록 시 대시보드 공개키로 교체하고 운영 `ALLOWED_ORIGINS` 설정
  - 개인정보처리방침과 UI 내 공개·동의 화면 없음 → 시청 정보(브라우징 활동)를 보내기 시작하는 Phase 4 전에 필요
  - 운영은 https/wss 필수 (정책의 보안 전송 요건). 지금은 localhost http 기본값
  - Extension은 브라우저를 다시 열면 재로그인 (`storage.session`)
  - side panel을 닫으면 WebSocket이 끊겨 오프라인으로 보임 (의도)
  - side panel 실제 컨테이너에서 `confirm()`/`alert()` 미확인 (탭으로 연 페이지에서만 확인)
  - Extension / Desktop / ui 자동 테스트 없음, lint 없음

## Next Task
Phase 5 — Desktop Integration (`Mirattic_Sync_PLAN.md`)
1. 차단 시 공통 방 정리 (Phase 2 known issue)
2. presence에 `IN_ROOM` 표시 여부 결정, DND
3. Desktop: 친구가 보는 콘텐츠에 "같이 보기"로 합류 (친구 presence의 영상으로 방 만들기 / 초대 수락 → 브라우저에서 열기)
4. Room invite 알림: Desktop notification (Tauri notification plugin), tray
5. 완료 조건: 친구가 보고 있는 콘텐츠에 Desktop에서 합류 가능
