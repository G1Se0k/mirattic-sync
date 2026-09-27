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
2. echo loop (프로그램 seek이 이벤트를 다시 발생) → sync-core에서 억제 창. MVP는 host만 전파
3. Autoplay 정책 → 방 참가 시 "동기화 시작" 클릭으로 사용자 동작 확보
4. YouTube 광고 → adapter가 `adPlaying` 노출, 광고 중 sync 일시중지
5. Netflix는 `video.currentTime` 직접 변경 시 오류가 알려져 있음 → Phase 6 정책 검토 시 결정
6. Extension 로그인 → MVP는 extension에서 별도 로그인
7. Chrome Web Store 사용자 데이터 정책 (시청 기록 = 브라우징 활동) → 개인정보처리방침, 최소 host_permissions

## 정책 확인 (각 provider 작업 직전, `docs/platform-policy/`에 날짜와 함께)

- Chrome Web Store 정책 — Phase 3 시작 시
- YouTube (youtube.com 페이지의 `<video>` 제어가 API ToS 대상인지 불확실) — Phase 4 시작 시
- Netflix 이용약관 — Phase 6
- Laftel 이용약관 / 동시 재생 제한 — Phase 7
