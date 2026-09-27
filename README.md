# Mirattic Sync

친구가 보고 있는 콘텐츠를 확인하고, 합류해서 재생을 동기화하며 영상 옆에서 대화하는 소셜 워치파티 앱.
Mirattic은 재생 **메타데이터만** 동기화한다. 영상/음성을 스트리밍·중계·저장하지 않으며 스트리밍 서비스 인증정보를 받지 않는다.

## 구조

```text
apps/desktop      Tauri 2 + React (macOS / Windows)
apps/extension    WXT (Chrome MV3) — content script + side panel
packages/types    공통 타입 (MediaPresence, PlaybackState, WebSocket envelope, MediaProviderAdapter)
server            Spring Boot 4 / Java 21 / MySQL (Maven)
docs              architecture / platform-policy / protocol / progress.md
```

## 요구 사항

Node 22, pnpm 12, Java 21, Rust (Tauri), Docker (MySQL, 서버 테스트의 Testcontainers)

## 실행

```sh
pnpm install

# Desktop
pnpm --filter @mirattic/desktop tauri dev

# Extension: 빌드 후 chrome://extensions → "압축해제된 확장 프로그램 로드" → apps/extension/.output/chrome-mv3
pnpm --filter @mirattic/extension dev

# Backend
docker compose up -d mysql
cd server && ./mvnw spring-boot:run      # http://localhost:8080/actuator/health
```

DB 접속 정보는 환경변수 `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`로 덮어쓴다 (기본값은 docker-compose 로컬 개발용).

## 검증

```sh
pnpm typecheck && pnpm test && pnpm build
cd server && ./mvnw test
```
