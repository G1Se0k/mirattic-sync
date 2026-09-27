# Mirattic Sync

친구가 보고 있는 콘텐츠를 확인하고, 합류해서 재생을 동기화하며 영상 옆에서 대화하는 소셜 워치파티 앱.
Mirattic은 재생 **메타데이터만** 동기화한다. 영상/음성을 스트리밍·중계·저장하지 않으며 스트리밍 서비스 인증정보를 받지 않는다.

## 구조

```text
apps/desktop      Tauri 2 + React (macOS / Windows)
apps/extension    WXT (Chrome MV3) — content script + side panel
packages/types    공통 타입 (MediaPresence, PlaybackState, WebSocket envelope, MediaProviderAdapter, REST DTO)
packages/client   REST + WebSocket 클라이언트 (토큰 갱신, 재연결) — desktop / extension 공용
packages/sync-core 동기화 엔진 (서버 시계 추정, drift 정책, SyncFollower, publishHost) + MockMediaProvider
server            Spring Boot 4 / Java 21 / MySQL (Maven)
docs              architecture / platform-policy / protocol / progress.md
```

## 요구 사항

Node 22, pnpm 12, Java 21, Rust (Tauri), Docker (MySQL, 서버 테스트의 Testcontainers)

## 실행

```sh
pnpm install

# Desktop (Tauri 앱. refresh token은 OS 키체인에 저장)
pnpm --filter @mirattic/desktop tauri dev
# 브라우저에서 두 사용자로 테스트: pnpm --filter @mirattic/desktop dev → http://localhost:1420 탭 두 개

# Extension: 빌드 후 chrome://extensions → "압축해제된 확장 프로그램 로드" → apps/extension/.output/chrome-mv3
pnpm --filter @mirattic/extension dev

# Backend
docker compose up -d mysql
cd server && JWT_SECRET=$(openssl rand -base64 48) ./mvnw spring-boot:run   # http://localhost:8080/actuator/health
```

서버 환경변수:

| 변수 | 필수 | 설명 |
|---|---|---|
| `JWT_SECRET` | ✅ | HS256 키, 32바이트 이상. 없으면 서버가 시작하지 않음 |
| `DB_URL`, `DB_USERNAME`, `DB_PASSWORD` | | 기본값은 docker-compose 로컬 개발용 |
| `ALLOWED_ORIGINS` | | CORS/WebSocket 허용 origin (콤마 구분). 기본값은 Tauri + Vite dev |

Desktop은 `VITE_API_URL`(기본 `http://localhost:8080`)로 서버 주소를 바꾼다.

## 검증

```sh
pnpm typecheck && pnpm test && pnpm build
cd server && ./mvnw test
```
