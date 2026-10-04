# Mirattic Sync

친구가 보고 있는 콘텐츠를 확인하고, 합류해서 재생을 동기화하며 영상 옆에서 대화하는 소셜 워치파티 앱.
Mirattic은 재생 **메타데이터만** 동기화한다. 영상/음성을 스트리밍·중계·저장하지 않으며 스트리밍 서비스 인증정보를 받지 않는다.

## 구조

```text
apps/extension    WXT (Chrome MV3) — content script + side panel
packages/types    공통 타입 (MediaPresence, PlaybackState, WebSocket envelope, MediaProviderAdapter, REST DTO)
packages/client   REST + WebSocket 클라이언트 (토큰 갱신, 재연결)
packages/ui       확장 side panel 화면 (React)
packages/sync-core 동기화 엔진 (서버 시계 추정, drift 정책, SyncFollower, publishHost; 테스트용 가짜 플레이어는 내부 전용)
server            Spring Boot 4 / Java 21 / MySQL (Maven)
docs              architecture / platform-policy / protocol / progress.md
```

## 요구 사항

Node 22, pnpm 12, Java 21, Docker (MySQL, 서버 테스트의 Testcontainers)

## 실행

```sh
pnpm install

# Extension: 빌드 후 chrome://extensions → "압축해제된 확장 프로그램 로드" → apps/extension/.output/chrome-mv3
# 툴바 아이콘 → side panel에서 로그인. ID는 manifest key로 ffoifpjldcgdiipbhljkofgifmefgohk 고정
pnpm --filter @mirattic/extension dev

# Backend
docker compose up -d mysql
# Mirattic Auth를 로컬로 띄운 뒤 (Auth 저장소, 기본 http://127.0.0.1:9000, dev client secret `dev-sync-secret`)
cd server && AUTH_ISSUER=http://127.0.0.1:9000 AUTH_CLIENT_SECRET=dev-sync-secret \
  AUTH_REDIRECT_URI=http://127.0.0.1:8080/auth/callback ./mvnw spring-boot:run   # http://127.0.0.1:8080/actuator/health
```

서버 환경변수:

| 변수 | 필수 | 설명 |
|---|---|---|
| `AUTH_CLIENT_SECRET` | ✅ | Mirattic Auth client `mirattic-sync`의 원본 secret. 없으면 서버가 시작하지 않음 |
| `AUTH_ISSUER` | | 기본 `https://auth.mirattic.com` |
| `AUTH_REDIRECT_URI` | | 기본 `https://sync.mirattic.com/auth/callback`. 로컬은 `http://127.0.0.1:8080/auth/callback` (확장도 `VITE_API_URL=http://127.0.0.1:8080`: 로그인 쿠키가 같은 호스트여야 함) |
| `AUTH_EXTENSION_REDIRECTS` | | 로그인을 돌려줄 확장 redirect (기본 `https://ffoifpjldcgdiipbhljkofgifmefgohk.chromiumapp.org/`) |
| `DB_URL`, `DB_USERNAME`, `DB_PASSWORD` | | 기본값은 docker-compose 로컬 개발용 |
| `ALLOWED_ORIGINS` | | CORS/WebSocket 허용 origin (콤마 구분). 기본값은 확장 ID |

Extension은 `VITE_API_URL`(기본 `http://localhost:8080`)로 서버 주소를 바꾼다.

## 검증

```sh
pnpm typecheck && pnpm test && pnpm build
cd server && ./mvnw test
```
