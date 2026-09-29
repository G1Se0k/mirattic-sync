# Current Phase
Phase 10 — Deployment (서버 배포 · 릴리스 자동화 완료, 2026-09-29. Codex Sol PASS. DB 백업 추가. 스토어 제출 · 서명 · 백업 외부 보관은 Next Task)

운영: https://sync.mirattic.com (`wss://sync.mirattic.com/ws`)

이전: Phase 9 (커밋 `f74074e`), Phase 8 (커밋 `9285bf1`, `06a32d8`), Phase 7 (커밋 `dc61f6a`), Phase 6 (커밋 `f03134d`), Phase 5 (커밋 `1a14137`), Phase 4 (커밋 `1f79672`), Phase 3 (커밋 `6651a72`), Phase 2 (커밋 `104fdc4`), Phase 1 (커밋 `c4494fe`), Phase 0 (커밋 `300eb5f`)
저장소: https://github.com/G1Se0k/mirattic-sync (private)

## Completed
### Phase 10
- **서버 자동 배포** (결정 62): main push → CI(web · server 통과 후) `deploy` job
  - jar 빌드 → `RUN` 없는 `server/Dockerfile`로 linux/arm64 이미지 → `docker save`를 SSH로 호스트에 `docker load` (레지스트리 없음)
  - 호스트(Apple Silicon macOS + OrbStack) 클론 `~/Documents/mirattic-sync`를 그 커밋으로 checkout → `deploy/deploy.sh <sha>`: `:current` 교체, `compose up`, 헬스 체크(120초). compose 실패·헬스 실패 모두 이전 이미지로 되돌림. 태그 이미지 5개 보관
  - 비밀값(`DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `JWT_SECRET`)은 첫 배포 때 호스트에서 생성 → `deploy/.env` (600, gitignore). CI에는 배포 전용 SSH 키(`DEPLOY_SSH_KEY`, 호스트 `authorized_keys`에 등록)와 고정된 `DEPLOY_KNOWN_HOSTS`만
  - `deploy/compose.yml`: MySQL 8.4 + 서버, `127.0.0.1:8090` (8080은 다른 프로젝트가 사용)
- **Caddy는 compose 밖** (사용자 요청, 결정 63): 호스트의 Caddy(`/opt/homebrew/etc/Caddyfile`)에 `sync.mirattic.com` 블록과 전역 Cloudflare `trusted_proxies` · `client_ip_headers CF-Connecting-IP` 추가 (백업 `Caddyfile.bak-mirattic-sync`, validate 후 reload, 기존 사이트 200 확인). 참고용 사본 `deploy/Caddyfile`
  - 서버 `server.forward-headers-strategy=native` → 인증 요청 제한이 실제 사용자 IP 기준
- **DB 백업**: `deploy/backup.sh`를 `deploy.sh`가 launchd agent(`com.mirattic.sync.backup`, 매일 04:00)로 설치 (스크립트는 TCC 밖 `~/Library/Application Support/mirattic-sync/`로 복사). `mysqldump --single-transaction` → `~/mirattic-sync-backups/*.sql.gz` (디렉터리 700 · 파일 600), 7일 보관. 개인정보처리방침 초안에 "삭제 후 백업에 최대 8일" 명시
- **WebSocket ping** 30초 (결정 64, Cloudflare 100초 유휴 종료 방지)
- **클라이언트 운영 주소** (결정 65): `apps/{desktop,extension}/.env.production`, Desktop CSP에 `https/wss://sync.mirattic.com`
- **Netflix seek** (결정 66, 결정 47 대체 · 사용자 결정): 따라가는 Netflix 탭에만 page world에서 Netflix 내부 플레이어 API로 이동, 실패하면 기존 "직접 이동" 안내. 켜기 안내 문구 갱신. `providers/netflix.test.ts` (세션 선택 · 반올림 · API 없음 → false · Netflix 밖 문서면 아무것도 안 함)
- **호스트 이탈 · 영상 변경** (결정 67, 사용자 요청): 호스트가 영상을 떠나면(뒤로가기 · 탭 닫기 → 호스트가 보냄, 창 · side panel 닫기 → 서버가) 멤버 일시정지. 영상이 바뀌면 멤버에게 팝업, 같은 묶음(`series`: YouTube 재생목록 · Laftel 작품 · Netflix 이어 본 화)이면 팝업 없이 자동 이동. Flyway V10 (`rooms.series`). Laftel 제목의 "다시보기" 제거
- **사용 편의 (결정 68, 사용자 요청)**: 확장 자동 로그인(`storage.local`), UI에서 Mock 방 생성 제거, 방 닫힘 알림 제거, 채팅 입력창을 화면 맨 아래로 · 메시지가 아래에서 위로 쌓임
- **Netflix 다음 화 감지 (사용자 보고: 재생바를 조작해야 감지)**: 원인 추정 — 플레이어가 새 `<video>`로 바꾸며 이벤트가 페이지의 첫 영상이 아닌 요소에서 나오거나 붙기 전에 발생 → adapter가 모든 `<video>` 이벤트를 받고, 1초 확인에 영상 유무 · 재생 상태도 넣음. 가짜 페이지에서 "붙기 전에 재생을 시작한 새 영상"으로 재현(옛 코드는 멤버가 따라가지 못함), 수정 후 통과. 실제 Netflix에서 재확인 필요
- 결정 68 · Netflix 감지 Codex Sol: 1차 FAIL (p10run11, blocking 1: `storage.local`은 기본적으로 content script도 읽음) → `setAccessLevel('TRUSTED_CONTEXTS')`로 확장 페이지만, 설정 실패 시 토큰을 읽지도 저장하지도 않음. non-blocking 3 (Mock 안내 문구, 요청 배너가 방 높이 밖에 있어 입력창이 밀림, 스토어 정책 문서) 수정. E2E: 브라우저를 닫고 다시 열면 자동 로그인, 로그아웃 뒤 다시 열면 로그인 화면. 재검증 1회차 **PASS** (p10run12, non-blocking 1: 남은 옛 문구 0.0.1 · `storage.session` → 수정)
- **Extension 엔진을 background로 (결정 69)**: 패널을 닫아도 동기화 유지·방 퇴장 아님. API client·socket·presence·따라가는 탭·현재 방의 `RoomSync`(sync-core 신규, Room.tsx의 동기화 로직을 옮김)가 background에, 패널은 port(`ui-port.ts`)로 보는 화면. 목록으로 돌아가도 방은 계속되고 패널을 다시 열면 그 방으로. keepalive 20초. 읽음은 패널이 방을 보여 줄 때만 새 WS 이벤트 `room:read`로 (방에 들어가 있는 것만으로는 읽음 아님)
- **감지 지연 수정**: "이 영상 열기"는 영상이 2초 넘게 방과 다를 때만 표시(입장·다음 화 이동 중 깜빡임 없음). 멤버 follower가 플레이어를 기다리는 동안 1초마다 재확인, 확장 업데이트 전부터 열려 있던 YouTube 탭은 스크립트를 한 번 다시 넣고 재연결 → 같은 영상이 열린 채 입장하면 링크 없이 동기화
- **일시정지 요청 (결정 70 → 74)**: 방 화면의 "일시정지 요청" 버튼(멤버) → 사유 → 호스트 팝업(30초 뒤 자동 닫힘, "모두 일시정지"), 30초 쿨타임 (서버 + 클라이언트). 새 WS 이벤트 `pause:request`. (처음엔 멤버가 멈추면 묻는 방식이었으나 오작동해 버튼으로 바꿈 — 아래 이력)
- **채팅 (결정 71)**: 신고 버튼 제거, 삭제는 "삭제된 메시지입니다"(회색·가로줄)로 남음(Flyway V11 소프트 삭제), 새 메시지 잠깐 강조
- **GUI 개편 (결정 72)**: 설정 화면 분리, 아이콘 버튼(인라인 SVG), 무채색 톤·이니셜 아바타·"⋯" 메뉴, 방 화면 상단 막대에 뒤로·알림·나가기 아이콘. side panel 상단 막대(확장 이름·고정·닫기)는 Chrome UI라 없앨 수 없음
- **Netflix · 일시정지 · 방 정리 (결정 73–75, 사용자 요청) — 이력**: Netflix 작품명·시즌·화를 내부 데이터로 표시하고 작품 ID로 다음 화 판단, 다음 화 전환 중 재생 중인 영상 요소를 고름. (이때 넣은 "멤버 정지 감지 → 팝업"과 "호스트는 한 방만"은 다음 항목에서 버튼·빈 방 닫기로 바뀜)
- **사용자 피드백 반영 (결정 73–75 수정)**: Netflix 다음 화 문제는 서비스 워커에 이동 로그가 없어 확장이 탭을 옮긴 것이 아님 (원인 미확인, 확장을 끈 상태 비교 요청). 재생바 조작 팝업은 버그 보고였음 → 멤버 정지 감지·팝업을 없애고 방 화면의 "일시정지 요청" 버튼으로(결정 74). "방이 비면 닫기"를 "호스트는 한 방만"으로 잘못 이해했던 것을 되돌리고 빈 방 자동 닫기로(결정 75, `EmptyRooms`, server 52). Netflix 제목은 내부 데이터가 실패해도 플레이어 제목 줄에서(결정 73). output 폴더 아이콘을 확장·데스크톱 아이콘으로 적용. p10run31 FAIL (blocking 2: 빈 방 확인과 닫기 사이 입장 가능, 플레이어가 없는 멤버는 요청 버튼이 안 보임) → 마지막 확인·닫기를 입장과 같은 방 잠금 안에서(`SocketHub.closeIfEmpty`), 버튼은 멤버면 항상. p10run32 FAIL (blocking 2: 쿨타임이 끝나도 버튼이 다시 안 켜짐, 다음 화 전환 중 이전 화 제목 줄을 새 화 제목으로 기억) → 쿨타임 끝에 상태 갱신, 화가 바뀐 순간의 제목 줄은 바뀔 때까지 기억하지 않음. p10run33 FAIL (blocking 1: 목록을 거쳐 다음 화로 가면 이전 화 제목 줄을 기억, non-blocking 1: netflix.md 앞부분이 옛 범위) → 마지막으로 본 제목 줄을 목록을 거쳐도 유지(`TitleLines`, extension 18), 정책 문서의 허용 범위·읽는 정보 갱신. p10run34 **PASS** (non-blocking 2: netflix.md 전송 정보에 제목 추가, 결정 67의 Netflix 묶음 설명을 결정 73 기준으로 표시 → 문서 수정)
- **영상 인식 속도 · YouTube 제목 (사용자 보고: 새 영상에서 "YouTube" → 이전 영상 제목 → 현재 제목 순, 가끔 이전 제목이 남음)**: 탭 제목이 URL보다 늦게 바뀌는 것이 원인 → YouTube는 플레이어 제목 링크(영상 ID로 확인)를 우선 사용, 탭 제목은 영상이 바뀐 순간의 것을 바뀔 때까지 쓰지 않음(공용 `TitleLines`). 모든 사이트에서 탭 제목이 바뀌거나 페이지가 이동하는 순간 바로 다시 확인(1초 확인은 유지). `docs/claude/validation.md`의 검증 모델 표기를 Sol로 맞춤. Codex p10run35 FAIL (blocking 1: 두 영상 제목이 실제로 같으면 영원히 거부) → 영상이 바뀐 지 3초가 지나면 같은 제목도 받아들임, 이동 때 예약한 확인은 정리 시 취소 (extension 21). p10run36 **PASS** (non-blocking 1: youtube.md 읽는 정보에 플레이어 제목 링크 추가 → 수정)
- **Netflix 크레딧 · 친구 코드 · 채팅 이름 (사용자 요청)**: 멤버는 끝 화면에서 "크레딧 보기"를 자동으로 누름(결정 76), 내 친구 코드를 설정에서 빼고 친구 추가 입력칸 위에 표시, 채팅에서 내 메시지도 "이름(나)". Codex p10run37 FAIL (blocking 1: 크레딧 유지가 방 영상에 묶이지 않아 다른 사이트·작품 탭에서도 누를 수 있음, non-blocking 1: 같은 버튼이 다시 나타나면 안 누름) → 방 영상 ID를 담아 같은 사이트 탭에만 전달하고 탭은 그 영상일 때만 누름, 버튼이 사라지면 다시 누를 수 있게. p10run38 **PASS** (non-blocking 1: 크레딧 버튼 선택자가 넓음 → 알려진 문제로 기록)
- **방 코드 · 방 생성 · 방 초대 (사용자 요청, 결정 77)**: 방마다 8자 코드, 코드를 아는 누구나 `POST /api/rooms/join`으로 입장(차단 404, 가득 409, 분당 10번 429, V12). 홈의 방 목록에 "방 생성"(지금 보는 영상, 없으면 사이트 선택 후 영상이 잡히면 생성)·"코드로 입장", 친구 행의 "같이 보기" 제거·합류 아이콘 교체. 방 안 "방에 초대하기": 친구별 "초대" → 30초 회색 "초대됨", 아래 "또는 방 코드로 초대". 호스트의 타임스탬프 클릭은 확인 없이 바로 이동, 친구 코드 안내 문구 제거. 확장 0.0.8. Codex p10run39 FAIL (blocking 4: 기존 방 코드 NULL, 코드 입장과 차단의 경합, 다른 방 입장 후에도 생성 대기가 남음, 데스크톱 흐름 / non-blocking 1: 코드 충돌) → V12가 기존 방에 코드를 채우고 NOT NULL, 차단을 공유 잠금으로 확인, 방에 들어가면 대기 취소, 코드 충돌 시 재발급. p10run40 FAIL (blocking 3: 코드 조회가 잠금보다 먼저 스냅샷을 만듦, 생성 응답이 다른 방 입장 뒤에 도착하면 이동, 데스크톱 / non-blocking 2: 두 번 눌러 방 두 개, 분 경계 제한) → 코드 조회부터 행 잠금, 응답 시 이미 방에 있으면 이동 안 함, 생성 중 중복 무시, 최근 60초 이동 창 제한. 데스크톱은 알려진 문제로 남김. p10run41 **PASS** (지적 없음)
- **빌드 규칙 (2026-09-29 사용자 결정)**: Desktop 설치 파일(dmg 등)은 더 만들지 않음 — 확장으로 모든 기능이 됨. `release.yml`은 확장 zip만. 빌드할 때마다 확장 버전 +0.0.1 (지금 0.0.8)
- **릴리스 자동화**: `v*` 태그 → `release.yml`이 Desktop 설치 파일(macOS universal `.dmg`, Windows `.exe`/`.msi`, 서명 없음)과 확장 zip을 draft release로. `v0.1.0` draft 생성 확인
  - 첫 실행에서 `@tauri-apps/plugin-opener` npm(2.5.5) · crate(2.6.0) 불일치로 Tauri CLI가 거부 → npm 2.6으로 맞춤 (기존 문제, Windows 빌드도 이번에 처음 통과)

### Phase 9
- **현재 상태 확인** (새 코드 없음): presence 공개 범위(`PresenceService.view`, 기본 presence=FRIENDS · 위치=ROOM_ONLY, `PresenceViewTest`), 차단(친구 관계 삭제 + 공유 방 분리, `FriendFlowTest` · `RoomFlowTest`), 방 권한(비멤버 404, 재생·콘텐츠 변경·초대는 호스트만 403, `RoomFlowTest`) 모두 기존 테스트로 보장됨
- **채팅 메시지 삭제**: 보낸 사람 또는 방 호스트(관리). `DELETE /api/rooms/{id}/messages/{messageId}` → 행 삭제, 모든 멤버의 연결에 `chat:delete { id }`
  - 채팅의 내 메시지(호스트는 모든 메시지)에 "삭제" (확인 창). 읽지 않은 메시지가 지워지면 목록 배지도 서버 수로 다시 맞춤
  - 재연결 후 기록을 다시 받을 때 끊긴 동안 지워진 메시지도 뺌 (`reconcile`), 늦게 온 기록 응답이 지운 메시지를 되살리지 않음
- **신고**: `POST /api/reports` (메시지 또는 사용자, 사유 4종 + 상세 500자). 채팅의 다른 사람 메시지, 방 멤버 목록, 친구 목록에 "신고" → 신고 창 → 접수 후 "차단하기" 제안
  - 볼 수 있던 대상만(내 방의 메시지, 친구 · 같은 방 멤버 · 내가 차단한 사람), 나머지 404. 메시지 내용 복사 보관, 같은 메시지 중복 무시, 하루 20건
  - 운영자 화면 없음 (DB `reports`), 로그에는 신고 ID만
- **계정 삭제**: 설정 맨 아래 "계정과 데이터 삭제…" → 비밀번호 재입력 → `DELETE /api/me` → 로그아웃 화면
  - 호스트인 방은 닫고 나머지 방에서는 나감, `users` 행 삭제로 FK cascade (identity, refresh token, 친구·요청·차단, 멤버십, 메시지, 신고). 남은 방 멤버에게 `chat:delete { userId }`, 친구·요청 상대에게 `friend:update`
  - 기존 access token 즉시 401 (JWT 검증기가 계정 존재 확인), WebSocket 연결은 서버가 닫음 (삭제 직전 ticket으로 연결해도 연결 직후 확인에서 닫힘). 틀린 비밀번호 403, IP당 분당 제한
- **개인정보처리방침 초안** `docs/legal/privacy-policy.md` (수집 항목·목적·보관·권리, 미정 항목 `[ ]`). Extension 동의 화면에 채팅·신고 항목 추가 (`CONSENT_VERSION` 올림 → 기존 사용자 다시 동의)
- Flyway V9 (`reports`), 결정 58–61 (`plan.md`)

### Phase 8
- **리액션** ❤️ 😂 😮 😭 🔥 (서버가 이 다섯 개만 허용): 채팅 입력 위 버튼, 지금 재생 위치를 붙여 WS `reaction:add`
  - `chat_messages`에 `reaction = true`로 저장, `chat:message`로 전달 (기록·페이지·방 삭제 정리 공유)
  - 채팅 목록 안에 표시. 연속된 같은 이모지가 첫 리액션 후 10초 안에, 영상 위치도 10초 안이면 "❤️ ×2 · 1:05"로 묶음. 이름은 툴팁. 호스트는 타임스탬프로 이동 (메시지와 같은 확인 창)
- **`chat:message`는 방의 모든 멤버의 연결로** (방에 들어와 있지 않아도)
- **읽지 않은 수**: 방 목록에 배지 (99+). 서버 `room_members.last_read_seq` (메시지 순번 `chat_messages.seq`)로 계산, `RoomView.unread`
  - 서버가 `room:join` · `room:leave` · 연결 끊김 때 기록 (방 행 잠금 아래, `room:update` 전에). 리액션과 내 메시지는 세지 않음
  - 목록에서는 실시간으로 올리고, 0.5초 뒤 서버 수로 다시 맞춤. 늦게 온 이전 목록 응답은 버림 (`latest()`)
- **방 알림 끄기** (방 화면 "채팅 알림 끄기/켜기", 서버 저장 `room_members.muted`, `PUT /api/rooms/{id}/members/me/muted`): 끈 방은 목록에 🔕와 흐린 배지. 바꾸면 내 모든 연결에 `room:update`
- **채팅 알림** (Desktop): 앱에 포커스가 없고 열린 방이 아니며 알림을 끄지 않은 방의 메시지 → "보낸 사람 · 방 제목". Extension은 알림 권한이 없어 배지만
- **기록 더 보기**: `GET /messages?before=<메시지 ID>` 100개씩 (`createdAt`, `id` 순 커서). "이전 메시지 더 보기"는 보던 위치 유지. 위를 읽는 중 새 메시지는 "새 메시지 ↓", 맨 아래이거나 내가 보낸 것은 따라 내려감
- Flyway V7(`reaction`, `muted`, `last_read_at`), V8(`seq`, `last_read_seq`로 교체)
- 결정 53–57 (`plan.md`)

### Phase 7
- 정책: **사용자가 직접 확인** (2026-09-28) — 라프텔은 제3자 개발자 정책이 없고, 위험은 Netflix보다 낮다고 판단 → Netflix와 같은 방식으로 진행 (사용자 결정). Claude는 약관 원문을 열람하지 못해 조항 원문은 미기록 (`docs/platform-policy/laftel.md`)
- **Extension**
  - 선택 권한 `https://laftel.net/*`. 켤 때 요청, 끄면 반납. Netflix와 **따로** 켜고 끔
  - `providers/laftel.ts`: `/player/<작품>/<에피소드>` ID, 탭 제목("… - 라프텔"에서 사이트 이름 제거), `<video>` 재생 상태. `entrypoints/laftel.content.ts`는 따라가는 탭에만 주입
  - **재생 / 일시정지 / seek** 모두 동기화 (Netflix와 달리 알려진 차단 없음). 채팅 타임스탬프 이동도 됨
  - `watch.ts`: Netflix 전용 상태를 실험 provider 집합(`EXPERIMENTAL`: 사이트 + 스크립트)으로 일반화. 경합 방지 카운터는 그대로
- **packages/ui**: `Experimental.tsx`를 provider별로 (`ExperimentControl`, `useExperiment`, 설정에 provider마다 섹션). 방 첫 입장 팝업도 provider별
- **types / Server**: Laftel contentId `"작품ID/에피소드ID"`(각 1–10자리 숫자) 검증 (전에는 검증 없음), `watchUrl` → `https://laftel.net/player/<id>`
- 결정 50–52 (`plan.md`)

### Phase 6
- 정책 확인: `docs/platform-policy/netflix.md` (2026-09-28, 이용약관 Last Updated 2026-04-10)
  - 약관 1.8(vi) "코드나 다른 제품을 삽입하거나 … 조작" 금지, 위반 시 **사용자 계정** 제한 가능 → 불명확 → 사용자 결정: 실험 기능, 기본 꺼짐, 사용자가 위험을 보고 켬
  - 법률 검토 체크리스트 (약관, 제3자 계약 위반 유도, 기술적 보호조치, 정보통신망법, 개인정보, Chrome 스토어, 상표). 법률 자문 아님, 스토어 공개 전 변호사 검토 필요
- **Extension**
  - Netflix 제어는 `optional_host_permissions`. 켤 때 Chrome 권한 요청, 끄면 반납 (Chrome 설정에서 권한을 빼도 꺼짐)
  - 켜는 곳: 친구 목록 아래 "실험 기능", Netflix 방에 처음 들어갈 때 뜨는 팝업(방마다 한 번). 약관 조항·계정 제한 위험·읽는 정보·광고 요금제 미지원을 보여줌
  - `providers/netflix.ts`: `/watch/<숫자>` ID, 탭 제목, `<video>` 재생 상태만 읽음. manifest에 없는 content script를 따라가는 탭에만 주입
  - **재생 / 일시정지만 동기화, seek하지 않음** (`currentTime` 쓰기 → Netflix 오류 M7375, 우회는 내부 API뿐). 멤버에게 "호스트보다 N초 늦음 · 직접 m:ss로 이동" 안내, 호스트의 채팅 타임스탬프 이동은 Netflix 방에서 없음
  - side panel은 YouTube 또는 (켜졌으면) Netflix 탭 하나를 따라감. 방에는 provider별 view (`RemoteAdapter.as`)
  - `providers/page-video.ts`: YouTube와 Netflix가 공유하는 `<video>` 페이지 adapter (YouTube 동작 변화 없음)
  - 채팅은 side panel 안 그대로 (별도 팝업 창은 요청 후 취소됨, 결정 49)
- **sync-core**: `seekable === false`면 seek 대신 `manual` 상태 (재생 중이면 1초마다 목표 위치 갱신)
- **types**: `MediaProviderAdapter.seekable`, `watchUrl`의 Netflix URL
- **Server**: Netflix contentId는 1–12자리 숫자 (방 생성 400, content-change `bad_payload`)
- 결정 45–49 (`plan.md`)

### Phase 5
- **합류 요청**: 친구가 YouTube를 보고 있으면 "합류 요청" → 친구에게 `watch:request` → 친구가 "같이 보기"를 누르면 내가 초대됨
  - 서버 `POST /api/rooms/requests` (친구만, 온라인일 때만, 같은 쌍 30초에 1회)
  - 받은 쪽 "같이 보기": 내가 호스트인 방이 있으면 그 방에 초대 (`POST /api/rooms/{id}/invites`, 신규), 없으면 지금 보는 영상으로 새 방
  - 요청은 방 화면에서도 배너로 보임
- **Desktop**
  - 초대 · 합류 요청 알림 (Tauri notification plugin, 앱에 포커스가 없을 때만. 브라우저 dev 모드는 Web Notification)
  - 트레이 아이콘 (열기 / 종료), 창을 닫으면 트레이로 숨김, macOS Dock 클릭으로 다시 열기
  - YouTube 방 → "YouTube에서 이 영상 열기"로 브라우저에서 열고, 그 브라우저의 side panel로 입장
- **차단 시 공유 방 정리**: 호스트가 아닌 쪽이 빠지고 실시간 이벤트도 끊김 (Phase 2 known issue 해결)
- `IN_ROOM`은 추가하지 않고 DND는 보류 (결정 43)
- `packages/client`: 본문 없는 응답(202)도 처리
- 서버 종료 중 WebSocket 정리에서 나던 `TransactionException` 경고 제거
- 결정 41–44 (`plan.md`)

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

## Major Files Changed (Phase 10)
- `server/{Dockerfile,.dockerignore}`, `deploy/{compose.yml,deploy.sh,Caddyfile}`, `.github/workflows/{ci.yml,release.yml}`
- `server/.../ServerApplication.java` (`@EnableScheduling`), `ws/SocketHub.java` (ping), `application.properties` (forward headers)
- `apps/{desktop,extension}/.env.production`, `apps/desktop/src-tauri/tauri.conf.json` (CSP), `apps/desktop/package.json` (plugin-opener 2.6)
- `docs/architecture/plan.md` (결정 62–65), `docs/protocol/websocket.md`

## Major Files Changed (Phase 9)
- `server/.../account/{AccountController,AccountService}.java`, `report/{Report,ReportRepository,ReportService,ReportController}.java`, `room/{RoomService,RoomController,ChatMessageRepository}.java`, `friend/FriendshipRepository.java`, `auth/TokenService.java`, `config/AuthRateLimitFilter.java`, `ws/{SocketHub,SocketHandler}.java`, `db/migration/V9__reports.sql`, `SafetyFlowTest.java`
- `packages/ui/src/{Report.tsx,Chat.tsx,Chat.test.ts,Room.tsx,Home.tsx,Privacy.tsx,App.css}`, `packages/types/src/index.ts`, `packages/client/src/api.ts`, `apps/extension/entrypoints/sidepanel/Consent.tsx`
- `docs/legal/privacy-policy.md` (신규), `docs/protocol/{rest,websocket}.md`, `docs/architecture/plan.md`

## Major Files Changed (Phase 8)
- `server/.../room/{ChatMessage,ChatMessageRepository,RoomMember,RoomService,RoomController}.java`, `ws/SocketHandler.java`, `db/migration/V7__chat_polish.sql`, `V8__chat_read_seq.sql`, `RoomFlowTest.java`
- `packages/ui/src/{Chat.tsx,Chat.test.ts,Home.tsx,Home.test.ts,Room.tsx,App.css}`, `packages/types/src/index.ts`, `packages/client/src/api.ts`
- `docs/protocol/{rest,websocket}.md`, `docs/architecture/plan.md`

## Major Files Changed (Phase 7)
- `apps/extension/{wxt.config.ts}`, `providers/{laftel,laftel.test,page-video}.ts`, `entrypoints/laftel.content.ts`, `entrypoints/sidepanel/{watch.ts,watch.test.ts}`
- `packages/ui/src/{Experimental.tsx,Room.tsx,session.ts}`, `packages/types/src/index.ts`
- `server/.../room/RoomService.java`, `RoomFlowTest.java`
- `docs/platform-policy/{laftel.md,chrome-web-store.md}`, `docs/protocol/{rest,websocket}.md`, `docs/architecture/plan.md`

## Major Files Changed (Phase 6)
- `apps/extension/{bridge.ts,wxt.config.ts,package.json}`, `providers/{page-video,youtube,netflix}.ts`, `entrypoints/netflix.content.ts`, `entrypoints/sidepanel/{watch.ts,watch.test.ts,main.tsx}`
- `packages/ui/src/{Experimental.tsx,Room.tsx,Home.tsx,session.ts,App.css}`
- `packages/sync-core/src/{sync.ts,sync.test.ts}`, `packages/types/src/index.ts`
- `server/.../room/RoomService.java`, `RoomFlowTest.java`
- `docs/platform-policy/{netflix.md,chrome-web-store.md}`, `docs/protocol/{rest,websocket}.md`, `docs/architecture/plan.md`

## Major Files Changed (Phase 5)
- `server/.../room/{RoomService,RoomController}.java`, `friend/FriendController.java`, `ws/SocketHandler.java`, `RoomFlowTest.java`
- `packages/ui/src/{Home.tsx,session.ts,App.css}`, `packages/client/src/api.ts`
- `apps/desktop/src/main.tsx`, `apps/desktop/src-tauri/{src/lib.rs,Cargo.toml,capabilities/default.json}`, `apps/desktop/package.json`
- `docs/protocol/{rest,websocket}.md`, `docs/architecture/plan.md`

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
- 62–65 (Phase 10): 레지스트리 없이 arm64 이미지를 SSH로 보내 호스트 클론에서 `deploy.sh`(헬스 체크 · 롤백), Cloudflare → 호스트 Caddy → 127.0.0.1:8090과 `CF-Connecting-IP` 기반 client IP, WebSocket ping 30초, `.env.production` · 태그 릴리스 — `plan.md` 참고
- 58–61 (Phase 9): 메시지 삭제는 보낸 사람 · 호스트, 실제 삭제 + `chat:delete`. 신고는 볼 수 있던 대상만 저장(운영 화면 없음). 계정 삭제는 비밀번호 재확인 후 즉시 완전 삭제(FK cascade), 토큰·소켓 즉시 무효. 개인정보처리방침 초안 — `plan.md` 참고
- 53–57 (Phase 8): 리액션은 채팅 메시지의 한 종류, 채팅은 모든 멤버 연결로, 읽지 않은 수는 서버 순번 기준, 알림 끄기는 멤버별 서버 저장, 기록은 커서 페이지 — `plan.md` 참고
- 50–52 (Phase 7): Laftel도 기본 꺼짐 · 선택 권한 · 따라가는 탭에만 주입(provider별 켜기), contentId `작품/에피소드`, Laftel은 seek함 — `plan.md` 참고
- 45–49 (Phase 6): Netflix는 기본 꺼짐 · 선택 권한, 따라가는 탭에만 주입, 재생/일시정지만 (seek 안내), provider별 view, 채팅은 side panel — `plan.md` 참고
- 41–44 (Phase 5): 합류는 요청 → 초대, 차단 시 호스트가 아닌 쪽이 빠짐, IN_ROOM 없음 · DND 보류, Desktop 트레이 · 알림 — `plan.md` 참고
- 33–40 (Phase 4): YouTube는 사용자 탭의 `<video>` 제어, URL은 contentId로 생성, content-change, 광고 중 명령 없음, 동의 화면, Platform 주입, side panel ⇄ content script port, 채팅 저장 — `plan.md` 참고
- 29–32 (Phase 3): Extension은 side panel이 소켓 소유, refresh token은 `storage.session`, 화면은 `packages/ui` 공유, 최소 권한 — `plan.md` 참고
- 18. MySQL은 FK `ON DELETE CASCADE` 컬럼에 CHECK를 허용하지 않아, 자기 자신 대상 요청/차단 금지는 서비스 계층에서 검증

## Tests
### Phase 10
- 로컬: server verify 48, JS 테스트 · typecheck · build, 운영 빌드에 운영 주소 포함, arm64 이미지 빌드
- `deploy.sh` 로컬 실행: 첫 배포(`.env` 600 생성) → 성공, 헬스 실패 이미지 → 이전 이미지로 롤백 후 UP, `compose up` 자체 실패(없는 entrypoint) → 롤백 후 UP, exit 1
- 전달 IP 신뢰: 로컬 · 호스트 loopback에서 서로 다른 `X-Forwarded-For`는 별도 제한
- 실제 파이프라인: CI web · server · deploy 성공, 호스트가 해당 커밋으로 동작. Cloudflare 경유로 가입 → `wss` 연결 130초 무통신 유지 → 계정 삭제, `X-Forwarded-For`를 위조해도 20번째에 429 (키는 `CF-Connecting-IP`)
- 백업: 배포 후 launchd로 즉시 실행 → 파일 생성(600), 임시 DB `restore_check`로 복원해 테이블 10개 · Flyway v9 확인 후 삭제
- 백업 Codex Sol 검증 FAIL (p10run3, 검사 통과, blocking 2) → 수정: 덤프 실패 시 부분 `.tmp`가 남고 보관 정리를 건너뜀 → 정리를 덤프 전에, 실패 시 `.tmp` 삭제(로컬에서 실패 재현 확인), 방침 문구에 서버 중단 시 예외 추가. launchd agent 로드 실패가 경고뿐 → 이미지 교체 전에 배포 실패로
- 백업 Codex 재검증 1회차 **PASS** (p10run4, `bash -n` · `sh -n` · server verify · typecheck · diff check · 실패 재현 · `plutil -lint`)
- Netflix seek (결정 66) Codex Sol: 1차 FAIL (p10run5, blocking 2: 이전 탭의 늦은 실패 응답이 새 연결을 seek 불가로 만듦, 탭이 다른 사이트로 옮겨 가는 사이 Netflix 함수가 그 탭에서 실행될 수 있음) → 호출 시 연결을 기억해 같은 연결일 때만 반영, 실행 전 탭 URL 확인. 재검증 1회차 FAIL (p10run6, URL 확인과 실행 사이 이동 경쟁) → 함수 안에서 실행 문서의 origin이 Netflix인지 먼저 확인 (테스트 추가, 빼면 실패 확인). 재검증 2회차 **PASS** (p10run7, extension 11)
- 호스트 이탈 · 영상 변경 (결정 67): server 49 (`membersPauseWhenTheHostsLastConnectionLeaves`, content-change `series` 저장 · 형식 검증), sync-core 15 (`publishHost` 영상 사라짐 → 그 위치로 pause, 돌아와 재생하면 play), extension 14 (YouTube 재생목록, Netflix 이어 본 화, Laftel "다시보기"). E2E(가짜 페이지, 확장 2개): 호스트 뒤로가기 → 멤버 정지 · 복귀 후 재생, 다른 영상 → 팝업 · 클릭 시 열기, 재생목록 진입 → 팝업, 같은 재생목록 다음 영상 → 자동 이동, 호스트 side panel 닫기 → 서버가 멤버 정지. Netflix: 플레이어 안 다음 화 → 자동, 목록 거쳐 다른 작품 → 팝업, 내부 API seek(M7375 없음) · API 없으면 직접 이동 안내. Laftel: 같은 작품 다음 화 → 자동, 다른 작품 → 팝업. 기존 yt · nf · lf E2E 갱신 후 통과
- 결정 67 Codex Sol: 1차 FAIL (p10run8, blocking 3) → 늦은 스냅샷 응답이 이전 영상으로 이동시키지 않게 무효화, 같은 영상에 재생목록만 붙어도 호스트가 알리고 서버는 재생 초기화 없이 방 정보만 갱신(`room:update`만), Netflix 묶음을 Navigation API `navigate` 이벤트로 즉시 끊음 (빼면 E2E 실패 확인), 문서 수정. 재검증 1회차 FAIL (p10run9, blocking 2) → 재생목록만 바뀐 URL을 1초 확인에서도 감지(빼면 URL만 바꾸는 E2E 실패 확인), 서버는 방 행 잠금 뒤 호스트 재접속 여부를 다시 확인(다시 들어온 연결의 재생은 이 정지 뒤에 적용). server 49 (RoomFlowTest: 같은 영상 메타데이터 변경 · 잠금 뒤 재확인). 재검증 2회차 **PASS** (p10run10, 지적 없음)
- 결정 69–72: server (RoomFlowTest `pause:request` 전달·쿨타임·호스트/비멤버/긴 사유 거절, SafetyFlowTest 소프트 삭제 자리표시·원문 없음), sync-core 21 (`RoomSync` 일시정지 요청·호스트 30초 표시, follower 직접 멈춤 대기·해제·패널 없으면 바로 재생·새 영상 정지는 요청 아님·플레이어 대기 중 재확인), ui 12 (자리표시·계정 삭제 메시지 제거), extension 15 (죽은 YouTube 탭 스크립트 재주입 1회). E2E `v3.cjs`(확장 2개): 설정 화면·친구 추가 아이콘, 영상 없으면 방 안 만듦, 같은 영상을 연 채 입장 → 링크 없이 동기화·버튼 깜빡임 없음, 멤버 패널 닫아도 동기화 → 다시 열면 그 방, 호스트 패널 닫아도 멤버 계속 재생·따라감, 일시정지 요청(사유 → 호스트 알림, 30초 쿨타임, 알림 30초 뒤 닫힘), 채팅 강조·신고 버튼 없음·삭제 자리표시(새로고침 후에도). 기존 yt · follow · nf · lf E2E를 새 UI로 고쳐 통과 (follow: 호스트 브라우저 종료 → 서버가 멤버 정지)
- 결정 69–72 Codex Sol 1차 FAIL (p10run13, blocking 2: 패널을 닫아도 방에 남으니 다시 열어 본 메시지가 계속 읽지 않음 → `room:read`; 방 명령에 방 ID가 없어 다른 창의 패널 명령이 활성 방에 적용될 수 있음 → 방 ID 확인, non-blocking 1: 일시정지 쿨타임 항목 정리 → 1만 개 넘으면 만료분 삭제). server 51 (RoomFlowTest `room:read`), E2E: 패널을 닫은 동안 온 메시지를 다시 열어 보면 배지 없음 (읽음 표시를 빼면 실패 확인). 재검증 1회차 FAIL (p10run14, blocking 1: 메시지 직후 0.5초 안에 닫거나 목록으로 가면 마지막 읽음이 빠짐) → 지연 없는 읽음 표시는 뷰어를 지우기 전에 바로 보냄. E2E는 서버의 읽지 않은 수를 직접 확인하도록 바꿈 (예전 코드면 1로 실패 확인). 재검증 2회차 FAIL (p10run15, blocking 1: 토큰 갱신 중 로그아웃하면 늦은 갱신 응답이 토큰을 다시 저장 — 원래 있던 문제, 자동 로그인으로 중요해짐) → API client에 세션 세대: 로그인·가입·로그아웃이 올리고, 다른 세대의 갱신 응답은 버리며 받은 토큰을 서버에서 폐기. background의 로그인 완료도 로그아웃 뒤면 아무것도 시작하지 않음. client 4 (로그아웃 중 갱신 테스트). 재검증 3회차 FAIL (p10run16, blocking 2: 갱신 토큰을 저장하는 도중 로그아웃하면 늦은 저장이 남음 → 토큰 쓰기를 한 줄로 세우고 실행 시점에 세션 확인·로그아웃이 줄 끝에서 읽고 비우고 폐기, client 5; 두 연결의 동시 일시정지 요청이 쿨타임을 우회 → 키별 `compute`로 확인·갱신을 한 번에). 사용자 요청으로 Codex 재검증 계속 (Claude는 직접 검증하지 않고 Codex에 넘김). p10run17 FAIL (패널이 열린 채 service worker가 재시작되면 다시 연결하지 않음) → 포트가 끊기면 진행 중 호출을 실패로 끝내고 0.5초 뒤 새 포트로 창·소켓·보던 방을 다시 알림. p10run18 FAIL (연결이 끊긴 동안 삭제된 메시지를 재연결 후 화면의 옛 원문이 덮음) → 기록을 합칠 때 서버 페이지가 우선, 기억한 삭제는 다시 적용 (ui 13). p10run19 **PASS** (non-blocking 1: 개인정보처리방침 초안의 삭제·신고 문구 → 수정)
- Release: `v0.1.0` → macOS universal · Windows 설치 파일 + 확장 zip draft release
- Codex Sol 검증 1차 FAIL (2026-09-29, 검사 12개 모두 통과, blocking 1) → 수정
  - `docker compose up -d`가 실패하면 `set -e`로 바로 종료되어 롤백하지 않음 → compose와 헬스 체크를 `if` 안에서 실행해 모든 실패가 롤백 경로로, 롤백 후에도 헬스 체크 (로컬에서 재현 · 확인). 수정본이 CI로 배포되어 운영 UP 확인
- Codex 재검증 1회차 **PASS** (2026-09-29, 검사 모두 통과: extension 8, sync-core 14, client 3, ui 11, typecheck, build, server verify 48, `git diff --check`, `sh -n`, compose config, arm64 이미지 빌드. 지적 없음, 이전 지적 해결 확인)

### Phase 9
- `SafetyFlowTest` 3 (신규): 메시지 삭제(남의 것 403, 비멤버·다른 방 404, 호스트 관리 삭제, `chat:delete` 전달, 기록에서 사라짐), 신고(메시지 내용 복사·삭제 후에도 유지, 중복 1건, 내 메시지 400, 비멤버 404, 친구·차단한 사람 가능, 모르는 사람 404, 둘 다/둘 다 없음/잘못된 사유 400, 하루 20건 뒤 429), 계정 삭제(틀린 비밀번호 403, `chat:delete { userId }` · `friend:update`, 소켓 닫힘, access token · ticket · refresh · 로그인 401, 삭제 전 받은 ticket 연결도 닫힘, 호스트 방 404, 남은 방·메시지·친구·요청 정리, 7개 테이블 행 0). 전체 server 47
  - 되돌리면 실패 확인: 연결 직후 계정 확인, JWT 계정 존재 검증
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 모두 통과, server 47, blocking 2 + non-blocking 1) → 수정
  - 하루 신고 한도를 잠금 없이 count 후 insert → 동시 요청으로 초과 가능 → 신고자 `users` 행을 먼저 잠가(`UserRepository.findForUpdate`) 한 사람의 신고를 직렬화
  - 한도 확인이 중복 확인보다 먼저라 한도에 닿으면 이미 한 신고의 재신고가 429 → 새 신고를 저장할 때만 한도 확인
  - (non-blocking) 모든 `DataIntegrityViolationException`을 중복으로 보고 204 → 잠금으로 중복 경쟁이 없어져 catch 제거 (대상 계정이 동시에 삭제되어 FK가 실패하면 성공으로 응답하지 않음)
  - 계정 삭제도 먼저 `users` 행을 잠금 → 삭제 중 나를 참조하는 방·초대·친구 요청은 기다렸다가 FK로 실패 (삭제 후 남는 방 없음)
  - `SafetyFlowTest` 4 (추가: 동시 신고 30건 → 정확히 20건, 메시지 1건. 잠금을 빼면 중복 insert로 실패 확인; 한도에서 기존 메시지 재신고 204). server 48, 안전 E2E 재실행 통과
- Codex 재검증 1회차 FAIL (2026-09-29, 검사 모두 통과, 이전 3개 해결 확인, blocking 1) → 수정
  - `chat:delete`가 먼저 오고 그 메시지의 `chat:message`가 늦게 오면 Chat이 다시 표시하고, Home은 배지·알림(목록에 없는 방의 대기 메시지 포함)을 냄 → Chat은 받는 메시지에도 삭제 기록 적용(`receive` 순수 함수), Home은 최근 삭제 100개를 기억해 늦은 메시지를 세지도 알리지도 않고 대기 메시지에서도 제거
  - ui 11 (역순 도착 테스트, 수정을 빼면 실패 확인). E2E 추가 (Playwright `routeWebSocket`으로 `chat:message`를 `chat:delete` 뒤로 미룸): 목록에서 배지·알림 없음, 방에서 표시 안 됨. Home 수정을 빼면 알림이 떠서 실패 확인. 안전 E2E 재실행 통과
- Codex 재검증 2회차 **PASS** (2026-09-29, 검사 모두 통과: extension 8, sync-core 14, client 3, ui 11, typecheck, build, server verify 48, `git diff --check`. 이전 지적 4개 해결 확인)
  - non-blocking 1: 개인정보처리방침 초안의 IP 보관 설명("1분 단위")이 실제와 다름 (지난 항목은 1만 개를 넘을 때만 정리, refresh·logout도 대상) → 문서를 실제 동작대로 수정 (코드 변경 없음)
- `packages/ui` 11 (추가 3: 삭제 반영 `without`, 재연결 `reconcile`, 역순 도착 `receive`). extension 8 · sync-core 14 · client 3, `pnpm typecheck` / `pnpm build` / `git diff --check` ✅
- E2E (Desktop web dev, 로컬 DB에 V9 적용): 메시지 신고(DB에 사유·상세·내용), 멤버는 호스트 메시지 삭제 버튼 없음, 내 메시지 삭제 → 사라지고 호스트 소켓에 `chat:delete`, 호스트가 내 메시지 삭제 → 화면에서 사라짐, 읽지 않은 메시지 삭제 → 배지 사라짐, 방 멤버 신고, 계정 삭제(틀린 비밀번호 안내 → 삭제 → 로그인 화면, 새로고침해도 로그인 없음, 친구 목록·DB 행 0, 이전 토큰 401). Phase 8 알림 E2E 6개 · 확장 채팅 E2E 재실행 통과

### Phase 8
- `RoomFlowTest` 20 (추가 4): 방 밖 멤버에게도 메시지·리액션 전달, 리액션 검증(`👍`, 숫자, `text` 키 → `bad_payload`), 읽지 않은 수(리액션·내 메시지 제외, 입장 · `room:leave` · 연결 끊김으로 읽음), 읽음 기록 직후 저장된 메시지 200회 반복 → 매번 1, 알림 끄기(비멤버 404, 내 두 연결에만 `room:update`), 150개 페이지(같은 밀리초 포함, 빠짐·겹침 없음, 다른 방 커서 404). 전체 server 43
  - 되돌리면 실패 확인: 연결 끊김 읽음 기록, 알림 끄기 `room:update`
- `packages/ui` 7: 같은 밀리초 id 순, 리액션 묶기(시간·위치), `latest()`(늦은 응답·무효화). extension 8 · sync-core 14 · client 3, `pnpm typecheck` / `pnpm build` ✅
- 수동 E2E (2026-09-28, 기존 로컬 DB에 V7 · V8 적용)
  - 확장 side panel 2개(360px), Mock 방: 목록 배지 1 (리액션 제외) → 새로고침 후에도 1 → 입장 시 리액션 표시, 같은 순간 ❤️ 두 개 → "❤️ ×2" → 나오면 배지 없음 → 알림 끄기 후 🔕 · 흐린 배지 → 105개: 맨 아래에서 100개, "이전 메시지 더 보기"로 앞 페이지 + 위치 유지 → 위를 읽는 중 "새 메시지 ↓", 맨 아래에서는 따라감
  - Desktop web dev (포커스 없음, `Notification` 가짜): 메시지 알림 "Sender · Movie Night", 리액션·열린 방·끈 방은 알림 없음, 방에서 다시 켜고 나오면 바로 알림 (방→목록 전달을 빼면 실패 확인)
  - Laftel E2E 재실행 통과 (채팅 타임스탬프 이동 포함)
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 모두 통과, blocking 3) → 수정
  - 리액션을 영상 위치로만 묶어 멈춘 영상에서 1분 간격도 한 줄 → 보낸 시각 10초 안 + 위치 10초 안
  - 읽음 시각과 같은 밀리초의 메시지가 영구히 누락 → 메시지 순번(`seq`)과 방 행 잠금으로 (V8). 입장 읽음 기록은 소켓 허브 잠금 밖으로
  - 늦게 온 방 목록 응답이 실시간 배지를 덮어씀 → `latest()`로 오래된 응답 버림 + 0.5초 뒤 서버 수로 재조회
- Codex 재검증 1회차 FAIL (이전 3개 해결 확인, blocking 1) → 방 안에서 바꾼 알림 설정이 목록에 늦게 반영 → `onMuted`로 즉시 반영, 진행 중 목록 응답 무효화
- Codex 재검증 2회차 FAIL (이전 4개 해결 확인, blocking 1) → 같은 계정의 다른 앱에 알림 설정이 전달되지 않음 → 저장 후 내 모든 연결에 `room:update`
- Codex 재검증 3회차(자동 재검증 마지막) FAIL (검사 모두 통과, server 43, 이전 5개 해결 확인, blocking 2) → 사용자 보고
  - 초대된 방이 아직 목록에 없을 때 온 첫 `chat:message`를 버리고, 그 전에 시작된 목록 조회가 unread 0을 적용해 배지·알림이 누락될 수 있음
  - 다른 연결에서 알림을 끈 뒤 `room:update` 재조회가 끝나기 전에 온 메시지는 이전 설정으로 알림
- 사용자 요청으로 수정 (2026-09-28)
  - 목록에 없는 방의 메시지는 버리지 않고 대기 → 서버 목록(`applyRooms`, 재조회·reload 공통)에 나타나면 알림, 배지는 서버 수. 목록의 로컬 변경은 `updateRooms` 하나로 (진행 중 조회 무효화 + 소켓 처리기에 즉시 반영)
  - 알림 설정 변경의 `room:update`에 `{ muted }`를 담아 보내고, 받은 쪽은 조회 전에 바로 적용
  - E2E 추가 (Desktop web dev): 새 방 초대 직후 첫 메시지 3회 → 배지 1 · 알림, 다른 앱(REST)에서 알림 끈 직후 메시지 5회 (방 목록 GET을 1.5초 늦춤) → 알림 없음. 각 수정을 빼면 해당 E2E 실패 확인. `RoomFlowTest`는 `room:update`의 `muted` 값 확인. 채팅 E2E 재실행 통과
- Codex 추가 검증 (사용자 요청) FAIL (검사 모두 통과, server 43, blocking 2) → 수정
  - 목록을 적용할 때 아직 목록에 없는 방의 대기 메시지까지 지움 → 목록에 나타난 것만 알리고 나머지는 계속 대기 (최대 20개). `settleUnlisted` 순수 함수 + 테스트 (ui 8)
  - V8이 V7의 `last_read_at`을 그냥 지워 업그레이드 시 읽은 메시지가 모두 읽지 않음으로 → 기존 메시지에 시간순(`created_at`, `id`)으로 `seq`를 매긴 뒤 AUTO_INCREMENT로 바꾸고, `last_read_seq`를 "읽음 시각 이전 메시지의 최대 seq"로 채운 뒤 삭제. `ChatReadMigrationTest` (root로 별도 스키마를 V7까지 올리고 순서가 섞인 데이터 → V8: 읽음 유지, seq는 시간순, 새 메시지는 이어서). 이전 V8로 되돌리면 실패 확인. 로컬 DB는 이전 V8을 되돌린 뒤 새 V8 적용 (메시지 439개 → seq 1–439). server 44, E2E 두 개 재실행 통과
- Codex 추가 검증 2 FAIL (검사 모두 통과, server 44, blocking 1) → 수정
  - 방 화면의 `room:update` 재조회가 응답 순서를 구분하지 않아, 다른 앱에서 알림을 끄고 바로 켜면 늦게 온 이전 응답이 "꺼짐"으로 되돌림 → Room도 `latest()`(`format.ts`로 이동, Home과 공유)로 최신 조회만 반영, `room:update`의 `muted`는 바로 적용하고 진행 중 조회 무효화
  - E2E: 방을 연 채 다른 앱(REST)에서 끄고 0.2초 뒤 켬, 첫 방 조회 응답을 1.5초 늦춤 → "끄기" 버튼 유지 (가드를 빼면 실패 확인). 알림 · 채팅 E2E 재실행 통과, ui 8 · extension 8 · sync-core 14 · client 3, typecheck · build ✅
  - Room/Home 컴포넌트 테스트 도구가 없어 자동 컴포넌트 테스트는 없음 (`latest()` 단위 테스트 + E2E)
- Codex 추가 검증 3 (사용자 요청) **PASS** (2026-09-28, 검사 모두 통과: extension 8, sync-core 14, client 3, ui 8, typecheck, build, server verify 44, `git diff --check`. 이전 지적 모두 해결 확인, 발견 사항 없음)

### Phase 7
- `apps/extension` 8/8: `watch.test.ts` 추가 (Laftel은 켜졌을 때만 따라감, Netflix를 꺼도 Laftel 탭은 그대로 — 켜짐 확인·끌 때 provider 비교를 각각 되돌리면 실패 확인. "주입 중 끄면 연결 안 함"을 Netflix · Laftel 둘 다), `laftel.test.ts` 탭 제목 1
- `RoomFlowTest`: Laftel contentId 형식 (REST `40522` → 400, `40522/40523` → 생성, WS `40522/../x`·`40522/` → `bad_payload`). 전체 server 39/39
- client 3 · sync-core 14 · ui 3, `pnpm typecheck` / `pnpm build` ✅. 빌드된 manifest: host_permissions는 YouTube만, optional_host_permissions에 netflix · laftel, content_scripts는 YouTube만
- 수동 E2E (Playwright Chromium 3개, laftel.net을 가짜 페이지(`<video>` 하나, 제목 "장송의 프리렌 1화 - 라프텔")로 route, 2026-09-28. 2개는 laftel 권한을 미리 넣은 빌드 복사본)
  - 일반 빌드: laftel 권한 없음, 라프텔 탭을 따라가지 않음
  - 켜진 호스트: 탭을 따라가고 친구에게 "Laftel · 장송의 프리렌 1화 시청 중"
  - 꺼진 멤버: 라프텔 방 첫 입장 팝업 (라프텔 위험 문구) → "켜지 않고 계속" → 동기화 안 함 안내, 다시 들어가도 팝업 없음
  - 켜진 멤버: "Laftel에서 이 영상 열기" → 재생·일시정지 반영, 호스트 seek 2:00 → 멤버 120.2s / 120.2s
  - 호스트가 채팅 타임스탬프 클릭 → 확인 → 둘 다 이동
  - Netflix E2E, YouTube E2E 재실행 통과 (일반화 회귀 없음)
- **실제 라프텔 사이트·계정으로는 확인하지 않음** → Known Issues
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 8개 모두 통과, blocking 1 · non-blocking 1) → 수정
  - 방 첫 입장 안내를 방 ID로만 기억해, 같은 방이 다른 실험 provider로 바뀌면 그 provider 안내가 생략됨 → `방ID|provider`로 기억하고, 팝업은 묻는 provider가 방의 현재 provider일 때만 표시. UI에서는 방 player가 provider별 view라 방의 provider가 바뀌지 않아(결정 48) raw WS `content-change`로만 가능 → Room 컴포넌트 테스트 도구가 없어 자동 테스트 없음
  - (non-blocking) Laftel 테스트 부족 → 주입 중 끄기 테스트를 Laftel에도 적용 (가드 둘 다 되돌리면 두 경우 모두 실패 확인). Laftel·Netflix E2E 재실행 통과
- Codex Sol 재검증 1회차 **PASS** (검사 8개 통과 + `git diff --check`, 이전 지적 해결 확인). non-blocking 1: Laftel adapter의 URL ID 추출과 `<video>` 제어는 자동 테스트 없음 (Extension 테스트에 DOM 환경 없음, 서버·types 형식 검증과 E2E로만) → Known Issues

### Phase 6
- `packages/sync-core` 14/14 (추가: seek할 수 없는 플레이어는 재생만 맞추고 이동할 위치를 알림, 1초 뒤 목표 갱신. 가드를 빼면 실패 확인)
- `RoomFlowTest`: Netflix contentId 형식 (숫자가 아니면 400, 숫자면 생성)
- `pnpm typecheck` / `pnpm build` ✅, 빌드된 manifest: host_permissions에 netflix 없음, optional_host_permissions에만
- 수동 E2E (Playwright Chromium 3개, netflix.com을 가짜 페이지(`<video>` 하나, 제목 "Netflix", 프로그램 seek을 M7375로 표시)로 route, 2026-09-28)
  - headless Chrome은 권한 창을 누를 수 없어, 2개는 빌드 출력 manifest에 netflix를 미리 넣은 복사본, 1개는 일반 빌드
  - 일반 빌드: netflix 권한 없음, Netflix 탭을 따라가지 않음 ("지금 보는 영상" 없음)
  - 켜진 호스트: Netflix 탭을 따라가고 친구에게 "Netflix · Netflix 콘텐츠 시청 중"
  - 꺼진 멤버: Netflix 방 입장 시 위험 안내 팝업 → "켜지 않고 계속" → "꺼져 있어 동기화하지 않습니다", 다시 들어가도 팝업 없음
  - 켜진 멤버: "Netflix에서 이 영상 열기" → 호스트 재생 따라감, 일시정지·재개 반영
  - 호스트 seek(2:00) → 멤버 "호스트보다 119.6초 늦음 · 직접 2:05(으)로 이동", 멤버 페이지는 seek되지 않음(M7375 없음) → 직접 이동하면 동기화됨
  - 채팅: 타임스탬프 표시, 호스트도 클릭 이동 없음
  - YouTube E2E 전체 재실행 통과 (adapter 리팩터링 회귀 없음)
- **실제 Netflix 계정으로는 확인하지 않음** (계정 없음) → Known Issues
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 6개 모두 통과: sync-core 14, client 3, ui 3, typecheck, build(manifest 확인), server verify 39. blocking 1 · non-blocking 1) → 수정
  - Netflix 탭에 스크립트를 넣는 동안 권한이 해제되거나 다른 탭이 선택돼도, 주입이 끝나면 Netflix 탭에 연결될 수 있음 (꺼진 상태에서 읽기) → bind마다·끌 때 증가하는 카운터로, 주입 후 카운터가 그대로이고 켜져 있을 때만 연결. Extension에 테스트 도구가 없어 자동 회귀 테스트 없음, E2E 재실행 통과
  - (non-blocking) WS `content-change`의 잘못된 Netflix ID 테스트 없음 → "81a", 13자리 → `bad_payload` 테스트 추가
- Codex 재검증 1회차 FAIL (1차 지적 2개 해결 확인, 검사 6개 통과, blocking 1) → 수정
  - 처음 탭 선택(`pick`)이 탭 리스너 등록 전에 실행돼, 첫 Netflix 주입 중 탭을 바꾸면 이벤트를 놓치고 이전 Netflix 탭에 연결 → 리스너를 모두 등록한 뒤 처음 선택. E2E 재실행 통과
- Codex 재검증 2회차 FAIL (1·2회차 지적 해결 확인, 검사 6개 통과, blocking 1) → 수정
  - `pick`의 비동기 탭 조회가 그 사이 사용자가 고른 탭을 덮어쓸 수 있음 → 선택이 시작될 때마다(`pick`, 영상 탭 활성화) 증가하는 카운터로, 조회 후 카운터가 그대로일 때만 연결. 영상이 아닌 탭 활성화는 세지 않음 (따라가던 탭을 닫을 때 Chrome이 옆 탭을 활성화해도 넘겨받기가 취소되지 않게). E2E 재실행 통과
- Codex 재검증 3회차(자동 재검증 마지막) FAIL (이전 지적 모두 해결 확인, 검사 6개 통과, blocking 1) → 사용자 보고 후 수정 요청
  - 영상 탭 A → B를 빠르게 활성화했을 때 `tabs.get(A)`가 늦게 끝나면 이전 활성화 처리가 비활성 탭 A에 연결할 수 있음
- Codex **Astra** 추가 검증 (사용자 요청) FAIL (검사 통과, 이전 지적 해결 확인, blocking 1: Codex가 메모리 실행으로 재현)
  - 탭이 로드를 마쳐 연결(`onUpdated`)해도 대기 중인 `pick`이 무효화되지 않아 나중에 이전 탭으로 되돌림
  - → 같은 경합이 4번 지적돼 호출 경로마다가 아니라 한 곳에서 수정: **모든 연결이 거치는 `bind`가 선택 카운터를 올림** (이미 따라가는 탭이어도). 활성화 처리는 `tabs.get` 전에 순서를 기록하고 더 새 활성화가 있으면 버림 (3회차 지적)
  - **Extension 테스트 도입** (`apps/extension` vitest, `watch.test.ts` 5개, `wxt/browser`를 조회를 늦출 수 있는 가짜로 대체): 로드 완료가 느린 pick을 이김, 영상 탭 활성화가 느린 pick을 이김, 늦게 끝난 이전 활성화 무시, 주입 중 꺼지면 연결 안 함, 따라가던 탭을 닫으면 영상 아닌 옆 탭이 활성화돼도 넘겨받음
  - 가드를 하나씩 되돌리면 해당 테스트 실패 확인 (주입 후 켜짐 확인은 끌 때의 카운터 증가와 이중 방어라 둘 다 되돌려야 실패)
  - E2E 재실행 통과, 전체 JS 테스트 client 3 · sync-core 14 · ui 3 · extension 5
- Codex **Astra** 재검증 **PASS** (검사 8개 통과: extension 5, sync-core 14, client 3, ui 3, typecheck, build(manifest), server verify 39, 이전 지적 해결 확인). non-blocking 1개: 로드 완료 테스트가 실제로는 `onActivated`로 연결돼 `onUpdated` 경로를 검증하지 않음 → 영상이 아닌 탭 활성화(연결 없음 확인) 뒤 Netflix 로드 완료로 연결하도록 수정 (PASS 이후 테스트만 수정, 가드를 빼면 실패 확인)

### Phase 5
- `./mvnw test` RoomFlowTest 14/14, 전체 39/39 (추가 6, 동시 초대 · 동시 합류 요청 · 방 생성 중 차단 포함: 기존 방에 초대 — 호스트만·친구만·비멤버 404·이미 멤버는 재초대 안 함, 차단 시 양쪽 방 정리와 이벤트 차단, 합류 요청 — 오프라인 409·비친구 404·전달·30초 제한)
- `packages/client` 3/3, `sync-core` 13/13, `ui` 3/3, `pnpm typecheck` / `pnpm build`, `cargo check` ✅
- 수동 E2E (Playwright, 2026-09-28): 친구 A = 확장 + 가짜 youtube.com에서 재생 중, 나 B = Desktop 웹 빌드를 확장이 설치된 브라우저에서
  - B 친구 목록에 "YouTube · 제목 시청 중" → 합류 요청 → 다시 누르면 "방금 요청했습니다"
  - A side panel에 "B님이 같이 보자고 합니다" → 같이 보기 → A의 영상으로 방
  - B는 포커스가 없을 때 "A님의 같이 보기 초대 | 제목" 알림 → 입장 → "YouTube에서 이 영상 열기"로 브라우저 탭
  - 그 브라우저의 side panel에서 로그인 → 입장 → 동기화 (A 90.3s / B 90.1s)
  - Phase 4 E2E 전체 재실행 통과, 360px 친구 목록 확인
- 트레이 / 창 숨기기 / OS 알림은 Tauri 앱을 실제로 띄워 확인하지 않음 (cargo check만)
- Codex Sol 검증 1차 FAIL (2026-09-28, 검사 7개 모두 통과, blocking 2 · non-blocking 2) → 수정
  - 합류 요청 30초 제한의 조회와 기록이 분리돼 동시 요청이 모두 통과 → `compute`로 원자적으로. 동시 5개 → 202 1개 테스트 (분리된 버전으로 되돌리면 실패 확인)
  - 초대 인원 검사가 잠금 없이 이뤄져 동시 초대로 7명 초과 → 방 행 잠금 후 검사. 동시 7명씩 2번 → 한쪽만 성공 테스트
    - 이 테스트로 추가 발견: 잠금 전에 멤버십을 읽으면 MySQL REPEATABLE READ 스냅샷이 고정돼 대기한 트랜잭션이 이전 멤버 목록을 봄 → `lockAsHost`가 잠금을 먼저 잡도록 순서 변경 (playback 명령에도 적용)
  - (non-blocking) 같은 ID를 여러 번 넣으면 `room:invite`가 여러 번 감 → 실제로 추가된 멤버에게 한 번씩. 테스트 추가
  - (non-blocking) 합류 요청 수락이 실패해도 배너가 사라짐 → 성공 후에만 제거
  - 동시성 테스트 3회 반복 통과, Phase 5 E2E 재실행 통과
- Codex 재검증 1회차 FAIL (1차 지적 4개 해결 확인, blocking 1 · non-blocking 1) → 수정
  - 합류 요청에 응답할 때 지금 보는 영상과 상관없이 첫 호스트 방(예: Mock 방)에 초대 → 지금 보는 영상과 같은 내 방만 재사용, 없으면 새 방 (`roomToInvite`, 테스트 2개. 영상 비교를 빼면 실패 확인). 보는 영상이 없는 Desktop은 열린 방 → 아무 내 방
  - (non-blocking) 방 화면에서 초대 실패 메시지가 보이지 않음 → 방 화면에도 오류 표시
- Codex 재검증 2회차 FAIL (2회차 지적 해결 확인, blocking 1 · non-blocking 1) → 수정
  - 방 생성 · 초대가 친구 관계를 확인한 뒤 커밋 전에 차단이 끝나면, 차단 후 방 정리가 그 방을 못 봐 두 사람이 방을 공유함 → 친구 확인을 공유 잠금(`FOR SHARE`)으로 읽어 차단의 친구 관계 삭제가 그 트랜잭션 커밋까지 기다림. 방 정리는 차단 커밋 후라 새 방도 봄
    - 순서 고정 테스트: 방 생성 트랜잭션을 열어 둔 채 차단 → 차단이 기다리는지, 커밋 후 차단한 사람이 새 방에서 빠지는지 (잠금 없는 읽기로 되돌리면 실패 확인, 반복 통과)
  - (non-blocking) 합류 요청 제한 맵이 계속 커짐 → 요청마다 만료 항목 제거
- Codex 재검증 3회차 **PASS** (검사 7개 통과). non-blocking 1개: 열린 방에서 다른 방으로 바꾸면 Room 상태(재생 version 등)가 남음 → `key={openRoom}`으로 수정 (PASS 이후 한 줄 수정, typecheck · 테스트 · E2E로 확인)

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
- **Phase 10**
  - background 엔진: Chrome이 service worker를 강제로 끝내면(업데이트 등) 잠시 연결이 끊김 → 다시 시작하며 로그인·방을 복구하지만 그 사이 호스트였다면 서버가 멤버를 멈춤. 패널이 닫혀 있으면 초대·합류 요청 알림이 없음 (extension은 원래 알림 없음), 일시정지 요청은 묻지 않고 바로 재생, 호스트의 요청 알림도 패널을 열어야 보임
  - 데스크톱 앱은 이제 방 동기화 플레이어가 없음 (Mock 제거, 설치 파일 중단). 코드만 유지
  - 일시정지 요청 쿨타임은 서버 메모리 (서버 1대 전제, 1만 개 넘으면 만료분 정리)
  - 소켓이 다시 연결될 때의 `room:join`은 서버가 읽음으로 표시함 (패널이 닫혀 있어도)
  - 한 번에 한 방만 동기화 (다른 창의 패널에서 다른 방에 들어가면 그 방으로 바뀜)
  - 확장 refresh token이 `storage.local`(프로필 디스크에 평문)에 남음 — 자동 로그인을 위한 선택 (결정 68)
  - Netflix 다음 화 감지 수정은 가짜 페이지로만 확인 (실제 DOM 구조 미확인)
  - Netflix 내부 데이터 구조(`videoMetadata[id]._metadata.video`)는 공개 자료 기준, 실제 Netflix에서 미확인 — 없으면 예전처럼 "Netflix 콘텐츠"
  - Netflix "크레딧 보기" 버튼 선택자는 `watch-credits-seamless-button`(다음 화 버튼 이름에서 추정) 또는 `data-uia`에 credits가 들어간 첫 버튼 — 실제 이름 미확인, 같은 페이지에 다른 credits 버튼이 먼저 있으면 그것을 누를 수 있음
  - 호스트가 Netflix 끝 화면의 "다음 화"(`data-uia="next-episode-seamless-button"`)를 누르면 새로고침되며 그 화에 머무는 문제: **특정 브라우저에서만 발생** (다른 브라우저에서는 재현되지 않음, 2026-09-29 사용자 확인). 확장의 탭 이동 로그 없음 — 확장이 옮긴 것은 아님. 원인 미확인
  - **Desktop 앱의 "방 생성"은 지금 보는 영상이 없으면 사이트 선택 없이 안내만 표시** (Desktop은 탭의 영상을 감지하지 못함, 설치 파일도 더 만들지 않음). 영상을 보며 만드는 방 생성은 확장에서
  - 방 초대 "초대됨" 30초 제한은 클라이언트에서만 (패널을 새로 열면 초기화, 서버는 이미 멤버면 무시)
  - 호스트가 방 화면에서 친구 목록으로만 나가도(`room:leave`) 멤버가 일시정지됨 (탭에서 계속 보고 있어도). 그동안 호스트 조작은 원래도 전달되지 않음
  - Netflix "같은 작품"은 플레이어 안에서 넘어간 것으로 판단 → 엔딩 추천작을 바로 재생해도 멤버가 자동으로 따라감. 호스트 탭을 새로고침하면 다음 화도 팝업으로 물음
  - **Netflix 다음 화 문제(사용자 보고)는 실제 사이트에서 미확인**: 멤버가 이전 화에 남던 문제는 자동 이동으로 해결. 호스트 쪽이 넘어가지 않는 증상이라면 실제 증상 확인 필요
  - 탭을 다른 영상 탭으로 바꿔 따라가는 순간에도 "영상 사라짐"으로 멤버가 잠시 일시정지됐다가 새 탭 상태로 맞춰짐
  - **백업이 같은 호스트에만 있음** (디스크 · 호스트 장애 시 함께 잃음). 외부 보관(다른 기기 · 클라우드, 암호화) 필요. 백업 실패 알림 없음 (`~/mirattic-sync-backups/backup.log`만)
  - 백업 agent는 GUI 로그인 세션에 설치됨 → 호스트 사용자가 로그아웃하면 백업 안 됨 (OrbStack도 같은 조건)
  - 배포 호스트 1대(가정용 Mac) → 호스트 · 회선 장애 시 서비스 중단. 배포 중 수 초 중단(무중단 배포 아님), 접속 중인 WebSocket은 재연결
  - 배포 호스트 클론은 detached HEAD로 남음 (배포 전용, 직접 수정하지 말 것)
  - Desktop 설치 파일 서명 · 공증 없음 → macOS Gatekeeper · Windows SmartScreen 경고. 자동 업데이트 없음
  - Chrome Web Store 미제출: manifest `key`는 아직 dev 키, `ALLOWED_ORIGINS`의 확장 ID도 dev. 스토어 등록 후 교체 · 개인정보처리방침 게시 주소 필요
  - Cloudflare IP 대역은 Caddy에 고정 목록 (바뀌면 수동 갱신)
  - 로컬 E2E로 확장 · Desktop을 빌드할 때는 `VITE_API_URL=http://localhost:8080 pnpm build` (기본 빌드는 운영 주소)
  - 원래 계획의 운영 compose 안 Caddy는 사용자 요청으로 제외 (호스트에서 관리)
- **Phase 9**
  - **신고 운영 도구 없음**: 운영자는 DB `reports`를 직접 조회. 알림·처리 상태·제재(정지) 기능 없음
  - 신고는 신고자 또는 대상이 계정을 삭제하면 함께 지워짐 → 운영상 보관이 필요한지 법률·정책 검토 (`privacy-policy.md` `[ ]`)
  - 계정 삭제는 유예 기간·복구 없음, 데이터 내보내기 없음. DB 백업에 남는 기간은 Phase 10 운영 정책에서
  - 리액션은 UI에서 삭제·신고 버튼 없음 (서버 API로는 삭제 가능)
  - OAuth만 있는 계정은 비밀번호 재확인을 못 해 삭제 불가 (400, OAuth 도입 시 재로그인 확인 필요)
  - 계정 삭제와 동시에 들어온 신고·방 생성·초대·친구 요청은 FK 실패로 500 (드묾, 성공으로 응답하지는 않음). 계정 삭제 잠금의 동시성은 자동 테스트 없음
  - JWT 검증마다 사용자 존재 조회 1회 (기본 키). 부하가 보이면 짧은 캐시
  - 재연결 후 최근 기록이 비어 있으면(방 메시지가 모두 지워짐) 화면의 메시지를 지우지 못함 → 방을 다시 열면 정리됨
  - 인증 요청 제한의 IP 항목은 1만 개를 넘을 때만 정리됨 (메모리에만 있음). 운영 전 주기적 정리 검토
  - 개인정보처리방침 운영 주체·연락처·위탁·연령 미정, 법률 검토 전. 앱 안 링크 없음 (게시 주소가 생기는 Phase 10에)
  - 제3자가 차단한 두 사람을 같은 방에 초대하는 것은 여전히 막지 않음 (Phase 5 항목 유지)
- **Phase 8**
  - Extension은 채팅 알림 없음 (`notifications` 권한을 추가하지 않음, 배지만)
  - 같은 방을 한 기기에서 보고 있어도 다른 기기의 목록에서는 배지가 잠시 오름 (그 기기가 방을 열거나 서버 수로 재조회하면 맞춰짐). 읽음은 방에 "들어와 있던" 기준이라 여러 기기 중 하나만 열어도 모두 읽음
  - 열린 방이 아닌 다른 방의 새 메시지는 포커스가 있을 때 방 화면에서 표시되지 않음 (목록으로 돌아와야 보임)
  - Home / Room 컴포넌트 테스트 도구 없음 → 스크롤, 방→목록 알림 설정 전달은 E2E로만
  - Desktop 실제 OS 알림은 확인하지 않음 (웹 dev에서 가짜 `Notification`)
  - 리액션 되돌리기 없음 (채팅 메시지 삭제·신고는 Phase 9에서 추가)
  - 목록에 없는 방의 메시지 알림은 다음 목록 조회가 반영될 때까지 늦어짐 (보통 0.5초). 그 조회가 더 새 변경으로 버려지면 그다음 조회 때
- **Phase 7**
  - **라프텔 약관 조항 원문·개정일 미기록** (사용자 확인 결과만). 스토어 공개 전 원문 확인과 법률 검토 필요 (`laftel.md`)
  - **실제 라프텔 사이트로 검증하지 않음**: 플레이어 URL 형식(`/player/<작품>/<에피소드>`), 탭 제목 형식, `<video>` 하나인지, `currentTime` seek가 라프텔 플레이어와 어긋나지 않는지 모두 가짜 페이지로만 확인. URL 형식이 다르면 extension · types · server 세 곳의 형식을 함께 수정
  - 광고 감지 없음 (광고 회차가 있는지 미확인)
  - Extension 단위 테스트에 DOM 환경이 없어 page adapter(URL ID 추출, `<video>` 제어)는 E2E로만 검증
  - 다음 화 자동 재생 시 URL 변경은 YouTube처럼 content-change로 처리될 것으로 예상하지만 미검증
- **Phase 6**
  - **실제 Netflix 계정으로 검증하지 않음**: `<video>` play/pause가 Netflix 플레이어 UI와 어긋나지 않는지, 탭 제목 형식, 다음 화 자동 재생 시 URL 변경, 선택자(`video` 하나) 모두 가짜 페이지로만 확인
  - Netflix 약관상 허용 여부 불명확 → **스토어 공개 전 법률 검토** (`netflix.md` 체크리스트). 스토어 빌드에서 Netflix를 빼는 선택지도 검토
  - ~~seek 자동 동기화 없음~~ → 결정 66으로 내부 API seek (실제 Netflix에서 미검증, 비공식 API라 예고 없이 깨질 수 있음 → 그때는 직접 이동 안내)
  - 광고 요금제 미지원 (광고 감지 없음). 광고 중에도 재생/일시정지 명령이 갈 수 있음
  - 작품 제목·에피소드 정보 없음 (페이지 DOM을 읽지 않음). 탭 제목이 "Netflix"뿐이면 "Netflix 콘텐츠"로 표시
  - 콘텐츠 ID가 국가별로 같은지 미확인
  - lint 없음, desktop · types에 테스트 없음. Extension 테스트는 `watch.ts` 탭 선택만
  - Netflix 제어 켜기는 권한 창을 사람이 눌러야 해서 E2E에서 켜기/끄기 버튼 자체는 자동 확인하지 못함 (권한을 미리 준 빌드로 켜진 상태만 확인)
  - 처음 동의 화면 문구는 YouTube 기준. Netflix의 공개·동의는 켜기 화면이 대신함
- **Phase 5**
  - Tauri 앱을 실제로 실행해 트레이, 창 숨기기, OS 알림을 확인하지 않음 (기존 키체인 항목과 같이 첫 `tauri dev`에서 확인 필요)
  - 알림을 눌러도 해당 방으로 이동하지 않음 (앱만 보임)
  - Extension은 side panel이 닫혀 있으면 합류 요청 · 초대를 받지 못함 (접속 자체가 side panel 기준, 결정 29)
  - 합류 요청 제한은 서버 메모리 (서버 1대 전제)
  - 제3자가 호스트인 방에서는 차단한 사람이 빠짐 (차단당한 사람은 남음). 제3자가 차단한 두 사람을 같은 방에 초대하는 것은 막지 않음
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
- ~~CSP / `VITE_API_URL`이 localhost 고정~~ → Phase 10에서 `.env.production` · CSP로 해결
- Presence, WS ticket, rate limit 카운터가 서버 메모리에 있음 → 서버 1대 전제 (`ponytail:` 주석)
- ~~rate limit은 소켓 주소 기준~~ → Phase 10에서 `forward-headers-strategy=native` + Caddy `CF-Connecting-IP`로 해결
- WebSocket presence 전송 제한(250ms)은 초과분을 버림 → adapter가 상태 변화가 있을 때만 보내야 함
- `IN_ROOM`, `DND` 상태는 아직 없음 (Phase 5)
- **Phase 2**
  - 방 안에서의 `positionVisibility=ROOM_ONLY` 규칙은 따로 적용하지 않음 (방 멤버는 재생 상태를 받음. presence 위치는 여전히 친구에게 숨김)
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
  - ~~운영은 https/wss 필수~~ → Phase 10 운영 빌드는 `https/wss://sync.mirattic.com`
  - ~~Extension은 브라우저를 다시 열면 재로그인~~ → 결정 68로 자동 로그인 (`storage.local`, 확장 페이지만 읽음)
  - side panel을 닫으면 WebSocket이 끊겨 오프라인으로 보임 (의도)
  - side panel 실제 컨테이너에서 `confirm()`/`alert()` 미확인 (탭으로 연 페이지에서만 확인)
  - Extension / Desktop / ui 자동 테스트 없음, lint 없음

## Next Task
Phase 10 남은 일 (사용자 결정 필요)
1. 백업 외부 보관 위치 결정 (현재 같은 호스트에만 7일)
2. Chrome Web Store 제출 준비: 개발자 계정 등록 → 공개키로 manifest `key` 교체 · 운영 `ALLOWED_ORIGINS`에 스토어 확장 ID, 개인정보처리방침 `[ ]` 채우고 게시(예: `https://sync.mirattic.com/privacy`), 스토어 설명 · 스크린샷, YouTube · Netflix · Laftel 정책 재검토
3. Desktop 서명 · 공증 (Apple Developer ID, Windows 코드 서명 인증서)
