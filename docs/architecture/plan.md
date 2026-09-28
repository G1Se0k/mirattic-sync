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
| 29 | Extension의 API client와 WebSocket은 background가 아니라 side panel 페이지가 가짐 | MV3 service worker는 30초간 트래픽이 없으면 종료됨. side panel이 열려 있는 동안 = 같이 보는 동안이라 수명이 맞고, background ↔ panel 중계 코드가 필요 없음. Phase 4 content script는 side panel과 직접 메시지 |
| 30 | Extension refresh token은 `chrome.storage.session` | 디스크에 평문으로 남지 않음, content script 접근 불가. 브라우저 재시작 시 재로그인 (`platform-policy/chrome-web-store.md`) |
| 31 | 화면 컴포넌트는 `packages/ui`로 옮겨 Desktop과 Extension이 공유. 각 앱은 토큰 저장소만 다른 client를 `configure()`로 넘김 | 같은 화면을 두 번 작성하지 않음 (결정 9의 "필요해질 때") |
| 32 | Extension 권한은 `sidePanel`, `storage` + provider 사이트만 (Phase 4: `https://www.youtube.com/*` content script와 같은 host_permissions). API 서버는 host 권한 대신 CORS로 extension origin 허용 | Chrome Web Store 최소 권한 정책. content script match만으로는 side panel이 탭 URL을 볼 수 없어 같은 범위를 host_permissions로도 선언 (설치 경고 동일) |
| 33 | YouTube는 사용자가 연 youtube.com 탭의 `<video>`를 content script로 재생·일시정지·seek만 (IFrame Player API 아님) | 사용자 자기 로그인 상태 그대로, 임베드 제한 없음. 약관 해석은 불확실 → `platform-policy/youtube.md`, 스토어 공개 전 재검토 |
| 34 | 시청 페이지 URL은 provider + contentId로 클라이언트가 만든다 (`watchUrl`). 서버는 YouTube ID 형식(11자) 검증 | 호스트가 방에 임의 URL을 넣어 멤버를 다른 사이트로 보내지 못하게 |
| 35 | `playback:content-change`: 호스트 탭의 영상이 바뀌면 호스트 클라이언트가 다음 명령 전에 알림. 서버는 0초·일시정지로 초기화하고 version 증가. 멤버는 "이 영상 열기"를 눌러야 이동 | 멤버 탭을 자동으로 이동시키지 않음 (보수적). 초기화 후 호스트의 다음 명령이 바로 위치를 맞춤 |
| 36 | 광고 중에는 호스트가 명령을 보내지 않고(`publishHost`), adapter는 play/pause/seek를 무시 | 광고 시각이 멤버에게 가지 않게, 광고를 건너뛰거나 조작하지 않게 |
| 37 | 브라우징 활동 공개·동의는 side panel 첫 화면. 동의 전에는 YouTube 탭에 연결하지 않음. 동의 버전은 `storage.local` | Chrome Web Store 사용자 데이터 정책 (제품 UI 안에서, 수집 전에) |
| 38 | 앱별 차이는 `configure(api, socketUrl, platform)`의 `Platform`으로 주입 (adapter, 지금 보는 영상, presence 전송, 페이지 열기) | Desktop은 mock만 재생하고 실제 provider는 브라우저로 연다 |
| 39 | Extension ↔ content script는 side panel이 여는 port (`bridge.ts`). side panel은 이 창의 YouTube 탭(활성 → 마지막 → 아무거나)을 따라감 | 결정 29 (side panel이 소켓 소유)와 일관, 중계 없음 |
| 40 | 채팅은 DB(`chat_messages`, 방 삭제 시 함께 삭제)에 저장하고 WS로 참가자에게 전송, 입장·재연결 시 REST로 최근 100개 | 새로고침·재연결에도 대화 유지. 참가하지 않은 멤버는 입장할 때 기록으로 봄 |
| 41 | 친구 영상에 합류 = 합류 요청(`watch:request`) → 친구가 "같이 보기"로 초대 (호스트 방이 있으면 그 방에, 없으면 지금 보는 영상으로 새 방). 온라인 친구에게만, 같은 쌍 30초에 1회 (서버 메모리) | 남을 동의 없이 방에 넣거나 방을 만들게 하지 않음. 보고 있는 사람이 호스트가 되어야 위치가 맞음 |
| 42 | 차단하면 공유 방에서 호스트가 아닌 쪽이 빠짐 (차단한 사람의 방에서는 차단당한 사람, 그 외 방에서는 차단한 사람) | 호스트를 빼면 방이 닫혀 다른 멤버까지 영향 |
| 43 | `IN_ROOM` presence 상태는 추가하지 않음. DND는 보류 | 방 참여 여부는 비공개로 둠. `WATCHING`과 영상 정보로 합류 요청에 충분 |
| 44 | Desktop 창을 닫으면 트레이로 숨김 (접속·알림 유지, 트레이 "종료"로 끝냄). 초대·합류 요청 알림은 앱에 포커스가 없을 때만 (Tauri notification plugin). Extension은 알림 없음 | Extension에 `notifications` 권한을 더하지 않음 (side panel 배너로 충분) |
| 45 | Netflix는 실험 기능, **기본 꺼짐**. 켤 때 약관 1.8(vi) 위험을 보여주고 `optional_host_permissions`(`https://www.netflix.com/*`)를 요청, 끄면 반납. 설정의 "실험 기능"과 Netflix 방 첫 입장 팝업(방마다 세션당 1회)에서 켬 | 약관이 코드 삽입을 명시적으로 금지하고 위반 시 사용자 계정이 제한될 수 있음 → 사용자가 알고 선택 (사용자 결정, `platform-policy/netflix.md`) |
| 46 | Netflix content script는 manifest에 넣지 않고(`registration: 'runtime'`, 빌드 hook으로 host_permissions에서 제거) side panel이 따라가는 탭에만 `scripting.executeScript` | 꺼져 있을 때와 따라가지 않는 탭에는 코드가 전혀 들어가지 않음 |
| 47 | Netflix는 재생 / 일시정지만 제어하고 seek하지 않음 (`MediaProviderAdapter.seekable = false`). 멤버에게 `manual` 상태로 "N초 늦음 · mm:ss로 직접 이동" 안내, 호스트의 채팅 타임스탬프 이동도 없음 | `currentTime` 쓰기는 Netflix 오류 M7375, 우회는 내부 플레이어 API뿐 (금지) |
| 48 | side panel은 탭 하나(YouTube 또는 켜진 Netflix)를 따라가고 `RemoteAdapter`의 provider를 탭에 맞춤. 방에는 `as(provider)` view를 줘서 다른 provider 탭의 스냅샷은 null | 한 provider의 contentId를 다른 provider의 것으로 오인하지 않게 |
| 49 | Netflix 채팅도 side panel 안 (별도 팝업 창 없음) | 사용자 결정 (Teleparty도 분리하지 않음). 토큰·소켓을 가진 페이지가 하나로 유지됨 |
| 50 | Laftel도 Netflix와 같은 실험 기능: 기본 꺼짐, 선택 권한 `https://laftel.net/*`, 따라가는 탭에만 주입, 설정·방 첫 입장 팝업에서 위험을 보고 켬. 실험 provider는 각각 따로 켜고 끔 (`watch.ts` `EXPERIMENTAL`, ui `EXPERIMENTS`) | 개발자 정책 없음, 허용 여부 불명확 → 보수적 (사용자 확인·결정, `platform-policy/laftel.md`) |
| 51 | Laftel contentId는 `"<작품 ID>/<에피소드 ID>"` (각 1–10자리 숫자), URL은 `https://laftel.net/player/<contentId>` | 플레이어 URL에 둘 다 필요. 서버·types가 같은 형식을 검증 |
| 52 | Laftel은 seek함 (`seekable` 기본값) | Netflix M7375 같은 알려진 차단 없음. 실제 플레이어에서 문제가 보이면 `SEEKABLE`에서 끔 |

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
2. echo loop (프로그램 seek이 이벤트를 다시 발생) → 억제 창 없음 (결정 27). MVP는 host만 전파, 멤버의 자기 seek 이벤트는 재확인에서 차이 0으로 끝남 (Phase 4 가짜 페이지 E2E로 확인)
3. Autoplay 정책 → 방 참가 시 "동기화 시작" 클릭으로 사용자 동작 확보
4. YouTube 광고 → adapter가 `adPlaying` 노출, 광고 중 sync 일시중지
5. Netflix는 `video.currentTime` 직접 변경 시 오류(M7375) → seek하지 않고 안내만 (결정 47)
6. Extension 로그인 → MVP는 extension에서 별도 로그인
7. Chrome Web Store 사용자 데이터 정책 (시청 기록 = 브라우징 활동) → 개인정보처리방침, 최소 host_permissions

## 정책 확인 (각 provider 작업 직전, `docs/platform-policy/`에 날짜와 함께)

- Chrome Web Store 정책 — Phase 3 시작 시
- YouTube (youtube.com 페이지의 `<video>` 제어가 API ToS 대상인지 불확실) — Phase 4 시작 시
- Netflix 이용약관 — Phase 6 (2026-09-28, `platform-policy/netflix.md`)
- Laftel 이용약관 / 동시 재생 제한 — Phase 7 (2026-09-28 사용자 확인, `platform-policy/laftel.md`. 조항 원문 미기록)
