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
| 29 | ~~(결정 69로 대체)~~ Extension의 API client와 WebSocket은 background가 아니라 side panel 페이지가 가짐 | MV3 service worker는 30초간 트래픽이 없으면 종료됨. side panel이 열려 있는 동안 = 같이 보는 동안이라 수명이 맞고, background ↔ panel 중계 코드가 필요 없음. Phase 4 content script는 side panel과 직접 메시지 |
| 30 | ~~(결정 68로 대체)~~ Extension refresh token은 `chrome.storage.session` | 디스크에 평문으로 남지 않음, content script 접근 불가. 브라우저 재시작 시 재로그인 (`platform-policy/chrome-web-store.md`) |
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
| 47 | ~~(결정 66으로 대체)~~ Netflix는 재생 / 일시정지만 제어하고 seek하지 않음 (`MediaProviderAdapter.seekable = false`). 멤버에게 `manual` 상태로 "N초 늦음 · mm:ss로 직접 이동" 안내, 호스트의 채팅 타임스탬프 이동도 없음 | `currentTime` 쓰기는 Netflix 오류 M7375, 우회는 내부 플레이어 API뿐 (금지) |
| 48 | side panel은 탭 하나(YouTube 또는 켜진 Netflix)를 따라가고 `RemoteAdapter`의 provider를 탭에 맞춤. 방에는 `as(provider)` view를 줘서 다른 provider 탭의 스냅샷은 null | 한 provider의 contentId를 다른 provider의 것으로 오인하지 않게 |
| 49 | Netflix 채팅도 side panel 안 (별도 팝업 창 없음) | 사용자 결정 (Teleparty도 분리하지 않음). 토큰·소켓을 가진 페이지가 하나로 유지됨 |
| 50 | Laftel도 Netflix와 같은 실험 기능: 기본 꺼짐, 선택 권한 `https://laftel.net/*`, 따라가는 탭에만 주입, 설정·방 첫 입장 팝업에서 위험을 보고 켬. 실험 provider는 각각 따로 켜고 끔 (`watch.ts` `EXPERIMENTAL`, ui `EXPERIMENTS`) | 개발자 정책 없음, 허용 여부 불명확 → 보수적 (사용자 확인·결정, `platform-policy/laftel.md`) |
| 51 | Laftel contentId는 `"<작품 ID>/<에피소드 ID>"` (각 1–10자리 숫자), URL은 `https://laftel.net/player/<contentId>` | 플레이어 URL에 둘 다 필요. 서버·types가 같은 형식을 검증 |
| 52 | Laftel은 seek함 (`seekable` 기본값) | Netflix M7375 같은 알려진 차단 없음. 실제 플레이어에서 문제가 보이면 `SEEKABLE`에서 끔 |
| 53 | (결정 78로 없어짐) 리액션은 `chat_messages`의 한 종류 (`reaction = true`, text = 이모지 5개 중 하나). WS `reaction:add`로 보내고 `chat:message`로 받음. 채팅 목록 안에서 연속된 같은 이모지·10초 이내를 "😂 ×4 · 24:32"로 묶어 표시 | 별도 테이블 없이 기록·순서·페이지·방 삭제 정리를 그대로 씀. 영상 위 overlay 없음 (기획서 §13) |
| 54 | `chat:message`는 방에 참가한 연결이 아니라 **모든 멤버의 연결**로 보냄 | 방 밖(친구 목록)에서 읽지 않은 수를 올리고 알림을 띄우기 위해. 멤버는 어차피 기록을 볼 수 있어 공개 범위 변화 없음 |
| 55 | 읽지 않은 수는 서버 `room_members.last_read_seq`보다 순번(`chat_messages.seq`, AUTO_INCREMENT)이 큰 다른 사람의 메시지 수 (리액션 제외). 메시지 저장과 읽음 기록은 방 행 잠금으로 순서를 정함 (시각 기준은 같은 밀리초를 구별 못 함). `room:join`, `room:leave`, 연결 끊김 때 서버가 기록 (읽음 REST 없음). `RoomView.unread` | leave 처리 안에서 `room:update` 알림 전에 기록하므로 그 알림으로 다시 조회한 목록이 이미 0. 탭을 닫아도 끊김으로 기록 |
| 56 | 알림 끄기는 멤버별 서버 저장 (`room_members.muted`, `PUT /members/me/muted`). 끄면 채팅 알림만 없고 읽지 않은 수는 흐리게 표시. 채팅 알림은 앱에 포커스가 없고 열린 방이 아닐 때만 (Desktop만, Extension은 알림 권한 없음) | Desktop과 Extension이 같은 설정을 봄 (바꾸면 내 모든 연결에 새 값을 담은 `room:update { muted }`). 보고 있는 방은 알리지 않음 |
| 57 | 기록은 100개씩, `before=<메시지 ID>` 커서 (`createdAt`, `id` 순) | 같은 밀리초 메시지도 페이지 경계에서 빠지거나 겹치지 않음 |
| 58 | (삭제 방식은 결정 71로 바뀜) 채팅 메시지 삭제는 보낸 사람과 방 호스트(관리). 행을 실제로 지움 (소프트 삭제 없음), 모든 멤버의 연결에 `chat:delete { id }`. 리액션도 같은 API로 지워지지만 UI는 텍스트 메시지에만 버튼 | 개인정보: 지운 메시지는 서버에도 남지 않음. 호스트가 방 안의 괴롭힘을 바로 치울 수 있게 |
| 59 | 신고는 `reports` 테이블에 저장만 (운영자가 DB에서 확인). 볼 수 있던 대상만 신고 가능(나머지 404), 메시지 내용은 복사 보관, 신고자당 하루 20건 (신고자 `users` 행 잠금으로 직렬화, 중복 재신고는 한도와 무관하게 204). 신고 후 차단을 바로 제안 | 신고가 ID 탐색이나 운영자 폭주 수단이 되지 않게. 관리 화면은 운영 규모가 생기면 |
| 60 | 계정 삭제는 즉시 완전 삭제: `users` 행 잠금 + 비밀번호 재확인 → 방에서 나가기(호스트면 닫기) → `users` 행 삭제로 FK `ON DELETE CASCADE`가 나머지(identity, refresh token, 친구·차단, 멤버십, 메시지, 신고)를 지움. 삭제 후 access token은 JWT 검증기의 계정 존재 확인으로 즉시 401, WebSocket은 서버가 닫음(연결 직후에도 계정 확인) | 유예 기간·복구 없음(가장 단순하고 보수적). 훔친 access token만으로는 삭제 불가. 신고도 함께 지워지는 점은 운영 보관 정책 검토 필요 |
| 61 | 개인정보처리방침은 `docs/legal/privacy-policy.md` (초안). Extension 동의 화면에 채팅·신고 항목 추가 (`CONSENT_VERSION` 올림 → 다시 동의) | 스토어 제출 전 필수. 수집 항목은 코드 기준으로 적고 미정 항목은 `[ ]` |
| 62 | 서버 배포: main push → CI(web·server 통과 후)가 jar를 빌드하고 `RUN` 없는 Dockerfile로 linux/arm64 이미지를 만들어 `docker save`를 SSH로 보냄(`docker load`). 배포 호스트(Apple Silicon Mac + OrbStack)의 클론 `~/Documents/mirattic-sync`를 해당 커밋으로 checkout하고 `deploy/deploy.sh <sha>`가 `:current` 태그를 바꿔 `compose up` → 헬스 체크 실패 시 이전 이미지로 되돌림. 비밀값은 첫 배포 때 호스트에서 생성(`deploy/.env`, 600) | 레지스트리 없음 → 호스트에 레지스트리 자격 증명이 필요 없음(macOS 키체인은 SSH 세션에서 쓸 수 없음). 비밀값이 CI·저장소를 거치지 않음. 이미지 태그 5개 보관으로 수동 롤백 |
| 63 | 운영 경로: Cloudflare → 호스트의 Caddy(compose 밖, 사용자가 관리) → `127.0.0.1:8090`. Caddy는 Cloudflare 대역만 신뢰해 `CF-Connecting-IP`로 client IP를 정하고 `X-Forwarded-For`를 그 값으로 덮어씀. 서버는 `server.forward-headers-strategy=native`(Tomcat 기본 내부 프록시 = 사설·loopback만 신뢰) | 인증 요청 제한이 실제 사용자 IP 기준으로 동작. 앱 포트는 loopback에만 열려 외부에서 헤더를 위조할 수 없음 |
| 64 | 서버가 30초마다 모든 WebSocket에 ping 프레임 | Cloudflare는 100초 동안 조용한 WebSocket을 끊음. 브라우저가 pong을 자동으로 보내 클라이언트 변경 없음 |
| 65 | 클라이언트 운영 주소는 빌드 시 `.env.production`(`VITE_API_URL=https://sync.mirattic.com`). Desktop CSP는 운영·localhost 둘 다 허용. `v*` 태그 → Release 워크플로가 extension zip을 draft release로 (Desktop 설치 파일은 2026-09-29 사용자 결정으로 중단 — 확장으로 모든 기능이 됨) | 로컬 E2E는 `VITE_API_URL=http://localhost:8080 pnpm build`로 덮어씀. 서명·공증은 인증서가 생길 때 |
| 66 | Netflix도 seek함 (결정 47 대체, 2026-09-29 사용자 결정): side panel이 따라가는 Netflix 탭에만 `scripting.executeScript({ world: "MAIN" })`로 Netflix 내부 플레이어 API(`netflix.appContext…videoPlayer.seek`)를 호출 (`providers/netflix.ts` `seekInPage`). 실패하면 그 탭은 seek 불가로 보고 기존 "직접 이동" 안내로 돌아감. 켜기 안내 문구에 내부 기능 사용과 계정 위험을 명시 | 사용자 결정: Teleparty 등 기존 서비스와 같은 수준의 경험. 비공식 API라 예고 없이 깨질 수 있고, Netflix 약관 1.8 (v)(vi) 위반 소지 → 사용자 계정 위험. DRM · 스트림에는 손대지 않음. 스토어 공개 전 법률 검토 유지 (`platform-policy/netflix.md`) |
| 67 | 호스트 이탈 · 영상 변경 (결정 35 확장, 2026-09-29 사용자 요청): ① 호스트 탭의 영상이 사라지면(뒤로가기 · 탭 닫기) 호스트가 그 위치로 `playback:pause`, 호스트의 연결이 방에서 모두 빠지면(창 · side panel 닫기, 방 화면 나가기) 서버가 방을 일시정지. ② 영상이 바뀌면 멤버에게 "호스트가 영상을 바꿨습니다 · 이 영상 열기 / 나중에" 팝업. ③ `RoomContent.series`가 같으면 팝업 없이 멤버 탭을 새 영상으로 이동: YouTube = URL `list`, Laftel = 작품 ID, Netflix = (현재는 결정 73의 작품 ID; 그 정보가 없을 때만) 시청 페이지를 떠나지 않고 이어 본 화들(첫 화 ID, 목록으로 나가거나 새로고침하면 새 묶음). 방 입장 때와 이미 그 영상을 열어 둔 경우엔 아무것도 안 함 | 사용자 요청. Netflix URL에는 작품 ID가 없고 페이지를 더 읽지 않으려고 "플레이어 안에서 넘어감"을 같은 작품으로 봄 (엔딩 추천작을 바로 재생해도 같은 묶음으로 따라감). 멤버 탭 자동 이동은 같은 묶음일 때만 |
| 68 | 자동 로그인 (결정 30 대체, 2026-09-29 사용자 요청): Extension refresh token을 `storage.local`에 저장해 브라우저를 다시 열어도 로그인 유지. Mock 방은 UI에서 만들지 않음 (영상이 없으면 "같이 볼 영상을 먼저 여세요"), 방이 사라졌을 때 알림 없이 목록으로. 방 화면은 창 높이에 맞추고 채팅 입력은 맨 아래, 메시지는 입력 바로 위부터 쌓임 | 사용자 요청. refresh token은 Chrome 프로필에 평문으로 남지만 서버가 사용할 때마다 교체하고 재사용 시 family를 폐기. 로그아웃 · 계정 삭제 시 지움 |
| 69 | Extension 엔진은 background service worker (결정 29 대체, 2026-09-29 사용자 요청: 패널을 닫아도 싱크 유지·방 퇴장 아님). background가 API client(토큰 교체는 여기서만), socket, presence, 따라가는 탭(`watch.ts`), 현재 방의 `RoomSync`(sync-core: 입장·시계·호스트 전송·멤버 따라가기·영상 변경)를 가짐. side panel은 화면만: API 호출·소켓 전송을 port로 넘기고 상태를 받음(`ui-port.ts`). 20초마다 keepalive(`sync:request`)로 worker 유지. "방 나가기"·방 닫힘에서만 방을 떠남, 목록으로 돌아가도 방은 계속. 현재 방은 `storage.session`에 두어 worker가 다시 시작해도 돌아감. 방에 들어가 있어도 패널이 그 방을 보여 줄 때만 `room:read`로 읽음 표시. 방 명령·닫기·나가기에는 방 ID를 붙여 활성 방일 때만 처리 (다른 창의 패널이 활성 방을 바꾸면 이전 패널은 목록으로) | 패널 수명과 같이 보는 시간이 다름. 토큰 교체를 한 곳에서만 해 재사용 감지(로그아웃)를 피함. Chrome 116+에서 WebSocket 메시지가 worker를 살려 둠 |
| 70 | (멈춘 채 두지 않음 — 결정 74) 일시정지 요청: 멤버가 자기 플레이어를 멈추면(같은 영상에서 재생→정지, 새로 연 영상의 정지는 제외) 패널이 열려 있을 때만 "일시정지 요청을 보냅니까?"+사유(200자)를 묻고 그동안 멈춘 채 둠. 보내면 `pause:request { reason }` → 서버가 호스트의 모든 연결로 전달, 호스트 팝업은 30초 뒤 자동으로 닫힘("모두 일시정지" 가능). 멤버·방마다 30초 쿨타임 (서버 메모리 + 클라이언트). 패널이 닫혀 있으면 묻지 않고 바로 다시 재생 | 사용자 요청. 호스트 권한 모델은 그대로 (멤버가 방을 멈추지 못함) |
| 71 | 채팅 삭제는 소프트 삭제 (결정 58의 "행 삭제" 대체): 내용·영상 위치를 지우고 `deleted = true`, 기록에 "삭제된 메시지입니다"(회색·가로줄)로 남음. 읽지 않은 수에서 제외, 신고 불가(404). 계정 삭제는 여전히 행 삭제(FK cascade). 채팅 신고 버튼은 없앰(멤버·친구 신고는 유지), 새 메시지는 잠깐 강조 | 사용자 요청. 지운 내용은 서버에도 남지 않음 (자리만 남음) |
| 72 | GUI 개편: 설정 화면 분리(친구 코드·공개 범위·실험 기능·차단·로그아웃·계정 삭제), 버튼은 아이콘(인라인 SVG, 의존성 없음) + 접근 이름, 무채색 톤·이니셜 아바타·"⋯" 메뉴. "이 영상 열기"는 영상이 2초 넘게 방과 다를 때만(입장·다음 화 이동 중 깜빡임 방지). 확장 이름·고정·닫기가 있는 side panel 상단 막대는 Chrome UI라 확장이 없앨 수 없음 | 사용자 요청 |
| 73 | Netflix 콘텐츠 이름: 따라가는 탭의 page world에서 Netflix 내부 데이터(`netflix.appContext…videoPlayer.videoMetadata[id]`)로 작품명·시즌·화·에피소드 제목과 작품 ID를 읽음 (`metadataInPage`, 화마다 한 번, 로딩 중이면 2초 간격 5번). 작품 ID가 `series` → 새로고침·목록을 거쳐도 같은 작품의 다음 화는 자동으로 따라감 (없으면 결정 67의 "이어 본 화" 방식). 내부 데이터가 없으면 플레이어의 제목 줄(`[data-uia="video-title"]`, 컨트롤이 보일 때만 있음)을 화마다 기억해 사용. 영상 요소는 재생 중인 것, 없으면 가장 최근 것 (다음 화 전환 중 두 개일 때) | 사용자 요청. 결정 66과 같은 비공식 내부 API 사용 범위 확장 (읽기) — `platform-policy/netflix.md` |
| 74 | 일시정지 요청은 버튼으로 (결정 70의 "멤버가 멈추면 묻기" 대체, 2026-09-29 사용자 요청): 방 화면의 "일시정지 요청" 버튼 → 사유(200자) → `pause:request`, 30초 쿨타임. 멤버가 플레이어에서 직접 멈추면 예전처럼 곧바로 방 상태로 되돌림(감지·팝업 없음). 재생·정지 명령이 먹히지 않으면(자동 재생 거부 등) 1초마다 다시 시도 | 멤버 정지 감지는 Netflix 이동 중 정지 등으로 오작동했고, 사용자는 명시적인 버튼을 원함 |
| 75 | 빈 방은 자동으로 닫힘 (2026-09-29 사용자 요청): 서버가 1분마다 모든 방을 보고, 접속(참가) 중인 연결이 하나도 없는 상태가 연속 두 번이면(1–2분) 방을 닫고 멤버에게 `room:update` (호스트가 나간 것과 같음). 재연결·worker 재시작 같은 짧은 공백은 닫지 않음. (이전에 잘못 이해해 만든 "호스트는 한 방만"은 되돌림) | 아무도 없는 방이 목록에 남지 않게. ponytail: 서버 메모리·전체 스캔(서버 1대) |
| 76 | Netflix 끝 화면에서 멤버는 "크레딧 보기"를 자동으로 누름 (2026-09-29 사용자 요청): 방을 따라가는 멤버의 Netflix 탭이 방의 그 화를 보고 있을 때 `button[data-uia*="credits"]`가 나타날 때마다 한 번 클릭 (방 영상 ID를 탭에 전달, 같은 사이트 탭에만) → Netflix가 멤버를 혼자 다음 화로 넘기지 않고, 다음 화는 호스트를 따라감(결정 67·73). 호스트·방 밖에서는 누르지 않음 (`MediaProviderAdapter.keepCredits`) | 사용자 요청. 페이지 UI를 누르는 첫 조작 — `platform-policy/netflix.md`에 기록 |
| 77 | 방 코드 (2026-09-29 사용자 요청): 방마다 친구 코드와 같은 형식의 8자 코드(`rooms.code`, V12, 유일). 코드를 아는 사람은 누구나 `POST /api/rooms/join`으로 MEMBER가 됨 — 친구가 아니어도 됨. 막는 것: 기존 멤버와 차단 관계면 404(방 존재를 숨김), 8명이 차면 409, 사용자당 분당 10번 넘게 시도하면 429(코드 추측 방지). 친구 초대는 그대로 호스트만. 방 생성은 지금 보는 영상으로, 없으면 YouTube/Netflix/Laftel 중 고른 사이트를 열고 그 사이트 영상이 잡히면 만듦. 방 안 "방에 초대하기": 친구 옆 "초대" → 30초 동안 회색 "초대됨"(클라이언트), 아래에 방 코드 | 사용자 요청: "코드를 아는 누구나" |
| 78 | 리액션 삭제, 방 기록을 채팅에 (2026-09-29 사용자 요청): `chat_messages.reaction` 열과 기존 리액션 삭제(V13), `reaction:add` 없음. 방 기록은 `chat_messages.kind`(`join`/`leave`/`play`/`pause`/`seek`/`content`)가 있는 줄로 저장해 기록·순서·페이지를 같이 씀, 실시간은 `chat:log`(방에 참가 중인 연결에만), 채팅 가운데에 작게 표시. 입장 = 사용자의 첫 연결이 방에 들어옴, 퇴장 = 모든 연결이 빠진 뒤 10초(재연결·서비스 워커 재시작은 기록 안 함, 5초마다 확인, `RoomLog`). 재생/일시정지는 상태가 바뀔 때만, seek는 3초 안에 이어지면 같은 줄을 옮김(바를 끄는 동안 줄이 쌓이지 않게). 호스트가 나가 멤버가 멈추는 것은 퇴장 줄로 충분해 따로 안 남김. 읽지 않은 수·알림·삭제·신고에서 제외. 친구 코드 재발급 버튼도 UI에서 뺌(API는 남음) | 사용자 요청. 서버 기록이라 새로 들어온 멤버·다시 연 패널도 같은 줄을 봄 |
| 79 | 강퇴 · 호스트 위임 · 방 기록 다듬기 (2026-09-29 사용자 요청): 호스트는 멤버를 내보낼 수 있음(`DELETE /api/rooms/{id}/members/{userId}`, 연결도 방에서 뺌, "kick" 줄). 내보낸 사람은 방 코드로 다시 못 들어옴(`room_bans`, V14) — 호스트가 초대하면 풀림. 호스트는 다른 멤버에게 호스트를 넘길 수 있음(`POST /api/rooms/{id}/host`, 역할 교환, "host" 줄) → 클라이언트는 방을 다시 받아 역할에 맞는 엔진(발행/따라가기)으로 바뀜. 시크바를 끌면 플레이어가 일시정지→이동→재생을 보내므로 일시정지 줄은 3초 붙잡아 두고, 그 안에 재생이 오면 움직였을 때만 "이동" 한 줄(아니면 없음), 끄는 동안 오는 이동은 붙잡은 시간을 늘림. 이동 문구는 "호스트가 12:34로 이동했습니다". 방의 "영상 열기" 버튼은 항상 새 탭(호스트를 따라가는 자동 이동은 따라가는 탭 재사용) | 사용자 요청 |
| 80 | 이동 줄 병합 삭제 · 실험 기능 안내 · 친구 목록 표시 (2026-09-29 사용자 요청): 이동(seek)마다 줄 하나 — 3초 안 이동을 한 줄로 합치던 것(결정 78)과 `edited_at` 사용을 없앰(열은 V13에 남음, 항상 NULL). 시크바 끌기의 일시정지 붙잡기(결정 79)는 유지. Netflix/Laftel 제어가 꺼져 있으면 그 방에 들어갈 때마다 켤지 묻고(세션당 한 번 제한 삭제), 방 생성의 사이트 선택도 매번 물음. 그 사이트 탭에 들어간 것 자체는 제어가 꺼져 있으면 확장이 볼 권한이 없어(선택 권한) 알 수 없음 — `tabs` 권한은 넓어서 추가하지 않음. 친구 목록: YouTube는 제목 위에 채널 이름(`MediaPresence.channel`, 영상 아래 채널 링크 글자, 지금 영상의 것일 때만), Netflix는 제목 아래 줄에 "3화"(시즌 2부터 "시즌 2 3화"), 화수가 없으면 빈 줄 — Laftel도 같게(탭 제목 끝의 "N화"를 화수로 떼어 냄, 없거나 "1.5화"면 제목에 그대로). Netflix presence는 제목·시즌·화·화 제목을 따로 보내고 방 제목은 `contentTitle`로 합침 | 사용자 요청. 권한은 보수적으로 |
| 81 | Netflix/Laftel 권한 · 설정 · 표시 다듬기 (2026-09-29 사용자 요청·결정): `https://www.netflix.com/*`, `https://laftel.net/*`를 선택 권한에서 설치 때 받는 host_permissions로 바꿈(사용자 선택: 두 사이트만, `tabs` 권한 아님). 제어 켜기/끄기는 확장 설정(`storage.local` `mirattic.experiment.<사이트>`, 사이트마다 키 하나, 업데이트 직후엔 모두 꺼짐). 꺼져 있는 사이트의 탭이 창의 활성 탭이 되면(`offSite`) 어느 화면에서든 켤지 묻는 창을 한 번(도착마다) 띄움 — URL 확인만, 스크립트 없음, 서버로 안 보냄. 설정: 실험 기능은 버튼만 두고 위험 안내는 버튼에 마우스를 올리거나 포커스하면 표시, "호스트가 다른 영상으로 옮기면 물어보기"(`mirattic.askOnSwitch`, 끄면 묻지 않고 따라감; 같은 묶음은 원래대로 자동), 차단한 사용자는 버튼으로 열고 닫음. 전환 팝업의 "이 방에서 항상 허용하기"(RoomSync.followAlways, 그 방을 떠날 때까지). 친구 목록에서 "시청 중/일시정지" 문구 뺌. 내 정보 막대와 "지금 보는 영상" 카드도 채널 이름·화수를 따로 표시(`WatchingInfo`). 방 생성의 사이트는 새 탭. 사이트 표시는 사용자가 준 로고(정사각형으로 잘라 투명 배경, 96px, `packages/ui/src/assets`; 원본은 git에 넣지 않음). 모든 팝업을 "방 만들기" 창 모양으로 통일(`Dialog`: 흐린 배경 위 가운데, 제목, 내용, 오른쪽 아래에 취소/닫기 링크 다음 주 버튼, Esc·바깥 클릭으로 닫힘) — 브라우저 기본 confirm/alert도 `useAsk`로 바꿈 | 사용자 요청 |
| 82 | Mirattic Auth로 인증 이전 (2026-09-29 사용자 승인, Auth 저장소 `docs/migration.md` 옵션 B): 로그인·가입·비밀번호는 Mirattic Auth만. 확장은 `launchWebAuthFlow`로 `/auth/start` → Auth → `/auth/callback` → 일회용 handoff(60초, 확장 PKCE verifier에 묶임)로 Auth access/refresh token을 받고, refresh·logout은 서버가 client secret으로 Auth에 중계. API는 Auth access token만(RS256, JWKS, aud `mirattic-sync`). Sync 자체 가입·로그인·refresh token·비밀번호·JWT secret 제거(V15에서 `refresh_tokens`, `user_identities` 삭제) — 결정 19의 identity 분리와 결정 60의 비밀번호 재확인을 대체. `users.id` = Auth `sub`, 처음 보는 UID는 첫 로그인 때 프로필 생성. 이메일은 `/api/me`가 Auth UserInfo에서 매번 읽음(Sync는 저장 안 함). 계정 삭제는 Sync 프로필과 데이터만(Mirattic 계정은 Auth에 남음): `reauth=true`(Auth `prompt=login`, 60초보다 오래된 로그인이면 비밀번호 다시)로 받은 handoff가 같은 UID이고 `auth_time`이 5분 이내여야 함, 그 재인증 로그인은 바로 폐기 | 인증 일원화. 훔친 토큰만으로는 삭제 불가 유지 |
| 83 | 방 입장 · 일시정지 기록 · 사이트 선택 (2026-09-29 사용자 요청): 멤버가 방에 **들어갈 때**(패널의 `room:open`, 워커가 재시작 후 방을 복구할 때는 아님) 이 브라우저가 방 영상을 보고 있지 않으면 새 탭으로 엶(`RoomSyncDeps.openOnEnter`, 지금 보던 영상은 그대로). 패널이 워커 재시작 뒤 다시 보내는 `room:open`(`resume`)은 입장이 아님. 스냅샷이 아직 없으면(탭 연결 중) 1.5초 뒤 한 번 더 보고, 그사이 방 영상이 바뀌었거나 내가 호스트가 됐으면 열지 않음. 새 탭으로 열 때(입장, 방의 "영상 열기" 버튼) 같은 창에 그 영상이 열린 탭이 있으면 새로 만들지 않고 그 탭으로 전환(`samePage`: origin·경로, YouTube는 `v`까지). 호스트와 제어가 꺼진 Netflix/Laftel은 열지 않음. 일시정지 줄을 붙잡는 시간 3초→1초, 확인 주기 0.5초→0.2초(결정 79 조정): 시크바를 잡은 채 1초 넘게 멈추면 일시정지·이동·재생 줄로 나뉨. "어디서 볼까요?" 창은 확장이 영상을 인식하면 닫힘 | 사용자 요청. 일시정지 줄이 3~3.5초 늦던 것을 약 1.8초로 |
| 84 | 합류 요청 취소 · 자동 입장 (2026-09-29 사용자 요청): 합류 요청을 보낸 친구 줄에 "합류 요청 취소" 버튼(친구의 상태와 무관하게 표시) → `DELETE /api/rooms/requests/{friendId}` → 친구에게 `watch:cancel`(서버가 보낸 요청이 열려 있을 때만 한 번, 1시간 뒤 잊음), 요청 배너가 사라짐. 30초 재요청 제한은 유지(취소·재요청으로 반복 알림 방지). 요청한 친구가 그 사람을 초대 대상으로 지정하면(이미 멤버여도) 서버가 열린 요청을 닫고 `room:invite` 뒤에 `watch:answer`를 보냄 → 앱은 알림 없이 바로 그 방으로 입장(결정 83에 따라 필요하면 영상 탭도 열림). 응답 여부는 서버가 판단(패널의 목록은 취소 버튼 표시용, 늦게 온 목록이 이미 끝난 요청을 되살리지 않음). 응답(초대로 멤버가 됨)과 취소는 서버에서 한 잠금으로 순서를 정함(초대가 실패하면 요청을 되돌림, 1시간 지난 요청은 응답으로 쓰지 않음). 보낸 요청은 서버가 기억(`GET /api/rooms/requests`, 그 친구의 초대가 오거나 취소하면 닫힘)해 다시 연 패널도 취소 버튼·자동 입장을 되살림. 요청을 보내는 중에는 취소 버튼을 막음(서버가 요청을 알기 전 취소가 무시되지 않게). 패널이 닫혀 있는 동안 온 응답은 자동 입장하지 않음(백그라운드가 보관하지 않음, 알려진 한계) — 초대는 평소처럼 목록에 나옴 | 사용자 요청 |
| 85 | 초대장 (2026-09-29 사용자 요청): 호스트의 초대(방 생성 시 `inviteIds`, `POST /api/rooms/{id}/invites`)는 더 이상 바로 멤버로 넣지 않고 초대장(`room_invitations`, V16)을 만듦 → 초대받은 사람에게 `room:invite` + 앱 위쪽 배너 "○○님이 같이 보기에 초대했습니다 [입장] [거절]". 입장 = `POST /api/rooms/{id}/invitation`(멤버가 되고, 필요하면 결정 83의 영상 탭), 거절 = `DELETE`. 멤버 수 제한은 입장할 때 검사(가득 차면 409, 초대는 남음). 방이 닫히거나 계정이 삭제되면 초대도 사라지고(FK), 차단하면 서로의 방에 대한 초대도 지움. 내 합류 요청에 대한 응답(결정 84)은 초대장 없이 바로 멤버 + `watch:answer`. 추방된 사람의 초대는 추방을 풂(결정 79 유지). 추방된 상태에서는 예전 초대로 입장할 수 없고(404), 코드로 들어오면 그 방의 초대는 지워짐. 수락·거절하면 내 다른 앱에도 `room:update`(배너 정리). 방이 닫히면 초대받은 사람에게도 `room:update`. 합류 요청 응답으로 입장하면 그 방의 초대장도 지움. 다시 연 패널은 `GET /api/rooms/invitations`로 배너를 되살림 | 사용자 요청. 방이 원치 않게 목록에 생기지 않게 |
| 86 | 일시정지 기록을 즉시 (2026-09-29 사용자 요청, 결정 79·83 조정): YouTube 콘텐츠 스크립트가 시크바(`.ytp-progress-bar-container`)를 누르고 있는지를 스냅샷의 `scrubbing`으로 알리고, 호스트의 재생 명령에 실어 보냄. 서버 `RoomLog`: `scrubbing: false`인 일시정지는 바로 기록, `true`는 드래그가 끝날 때까지(드래그 시작부터 최대 30초) 붙잡아 재생이 오면 "이동" 한 줄, 놓았는데 멈춘 채면 일시정지 + 이동. 시크바를 놓으면 스냅샷을 한 번 더 보냄. 알 수 없는 사이트(Netflix·Laftel)는 값이 없어 기존처럼 1초 붙잡음 | 사용자 요청. 진짜 일시정지는 약 0.1초 안에 기록 |

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

방 기록(입퇴장·호스트 재생)은 `ChatMessage`의 한 종류 (`kind`, 결정 78). 리액션은 없어짐. 나중: `Notification`.

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
