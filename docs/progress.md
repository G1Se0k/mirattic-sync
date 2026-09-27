# Current Phase
Phase 0 — Repository & Architecture (완료, 2026-09-28)

## Completed
- git init, pnpm workspace (`apps/*`, `packages/*`), `tsconfig.base.json`
- `packages/types`: MediaProvider, MediaPresence, PlayerSnapshot, PlaybackState, DriftThresholds/DEFAULT_DRIFT,
  MediaProviderAdapter, Visibility, ChatMessage, ClientEvent/ServerEvent (source-only 패키지, 빌드 단계 없음)
- `apps/desktop`: Tauri 2 + React 19 + Vite, 템플릿 데모 제거, `@mirattic/types` import, CSP 설정
- `apps/extension`: WXT 0.21 (Chrome MV3). background(아이콘 클릭 → side panel), `youtube.content.ts`(로그만), `sidepanel/`
- `server`: Spring Boot 4.1.1 / Java 21 / Maven. Web, Security, JPA, WebSocket, MySQL, Flyway, Validation, Actuator
  - `SecurityConfig`: stateless, `/actuator/health`만 공개, 나머지 denyAll
  - 기본 in-memory user 비활성화 (생성 비밀번호가 로그에 찍히지 않도록)
  - DB 정보는 환경변수 (`DB_URL`, `DB_USERNAME`, `DB_PASSWORD`)
- `docker-compose.yml` (MySQL 8.4, 로컬 개발용)
- GitHub Actions CI: pnpm typecheck/test/build + `./mvnw test`
- README, `docs/architecture/plan.md`, `docs/protocol/websocket.md`(초안), `docs/platform-policy/README.md`

## Major Files Changed
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `docker-compose.yml`, `.github/workflows/ci.yml`
- `packages/types/src/index.ts`
- `apps/desktop/src/App.tsx`, `apps/desktop/src-tauri/{tauri.conf.json,src/lib.rs,Cargo.toml}`
- `apps/extension/{wxt.config.ts,entrypoints/*}`
- `server/pom.xml`, `server/src/main/java/com/mirattic/sync/config/SecurityConfig.java`,
  `server/src/main/resources/{application.properties,db/migration/V1__baseline.sql}`,
  `server/src/test/java/com/mirattic/sync/ServerApplicationTests.java`

## Architecture Decisions
`docs/architecture/plan.md` 참고. 요약:
- WXT, Chrome sidePanel API, raw WebSocket + JSON envelope, JWT + refresh rotation(bearer only), 일회용 WS ticket
- Extension ↔ Desktop은 Backend 경유
- 서버는 Maven (start.spring.io Gradle 생성이 2026-09-28에 500 에러)
- adapter는 `PlayerSnapshot` 반환, room 계층이 `PlaybackState`로 감쌈

## Tests
- `pnpm typecheck` ✅ / `pnpm build` ✅ (desktop vite, extension chrome-mv3)
- `pnpm test` — 아직 JS 테스트 없음 (Phase 2 sync-core부터)
- `cargo check` ✅, `pnpm tauri build --debug --no-bundle` ✅ (macOS)
- `./mvnw test` ✅ 2/2 (Testcontainers MySQL 8.4: health 공개, 그 외 403)

## Known Issues
- Windows 빌드 미검증 (CI에 Tauri macOS/Windows 매트릭스 없음 → Phase 5/10)
- CI 워크플로는 아직 GitHub에서 실행해 본 적 없음 (원격 저장소 없음)
- Extension 아이콘은 WXT 기본 아이콘, Desktop 아이콘은 Tauri 기본 아이콘
- Extension popup 제거함. Phase 3에서 로그인용 popup 추가 필요
- Tauri CSP는 `'self'`만 허용. Phase 1에서 API/WS origin을 `connect-src`에 추가해야 함
- Cargo 패키지명과 바이너리명은 아직 `desktop`
- 아직 커밋하지 않음

## Next Task
Phase 1 — Account / Friend / Presence
1. Flyway V2: `users`, `refresh_tokens`, `friendships`, `blocks`
2. `POST /api/auth/{signup,login,refresh,logout}` — BCrypt, JWT access(15분), refresh rotation + 재사용 감지(family revoke)
3. 친구 API: 요청 / 수락 / 거절 / 삭제 / 차단, 사용자 검색
4. `POST /api/ws-ticket`, `/ws` raw WebSocket handler, 메모리 presence 저장소, `presence:update` fan-out (친구·차단·visibility 검사)
5. 테스트: refresh 재사용 감지, 차단된 사용자·비친구에게 presence가 가지 않음
6. `packages/client` (REST + WS, 재연결), Desktop 로그인 화면 + 친구 목록 (Zustand, TanStack Query 도입)
