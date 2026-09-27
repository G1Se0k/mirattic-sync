# Mirattic Sync — Product & Technical Plan

## 1. 프로젝트 개요

Mirattic Sync는 **Netflix, Laftel, YouTube 등에서 각 사용자가 자신의 계정으로 콘텐츠를 재생하면서, 친구의 시청 상태를 보고 바로 합류하고, 재생 위치를 동기화하며, 영상 옆에서 실시간으로 대화할 수 있는 크로스플랫폼 소셜 워치파티 서비스**다.

핵심은 스트리밍 콘텐츠를 Mirattic이 직접 제공하거나 재전송하지 않는다는 점이다. Mirattic은 사용자 계정, 친구 관계, Presence, Room, 채팅, 재생 상태 메타데이터만 관리한다.

### 한 줄 정의

> 친구가 지금 무엇을 보고 있는지 확인하고, 한 번에 합류해 같은 장면을 보며 대화하는 소셜 워치파티 앱.

---

## 2. 제품 형태

Mirattic Sync는 세 부분으로 구성한다.

### 2.1 Desktop App

macOS와 Windows에서 동작하는 소셜 클라이언트.

담당 기능:
- Mirattic 계정 로그인
- 친구 추가 / 삭제 / 차단
- 친구 온라인 상태
- 친구가 현재 보고 있는 미디어 Presence
- 같이 보기 요청
- Room 생성 / 참가 / 초대
- 채팅 전체 보기
- 알림
- 프로필 및 개인정보 설정
- 확장 프로그램 연결 상태 확인

권장 기술:
- Tauri 2
- React
- TypeScript
- Vite
- Zustand
- TanStack Query

### 2.2 Browser Extension

Netflix / Laftel / YouTube 웹 플레이어를 감지하고 제어하는 확장 프로그램.

담당 기능:
- 현재 서비스 감지
- 현재 콘텐츠 감지
- 제목 / 에피소드 / URL / 재생 위치 / 길이 / 재생 상태 읽기
- play / pause / seek 동기화
- Room 상태 반영
- 웹페이지 오른쪽 또는 별도 레이아웃 영역에 Mirattic Chat Panel 표시
- 타임라인 반응 표시

초기 지원:
- Chrome
- Chromium 기반 Edge

추후:
- Firefox
- Safari

### 2.3 Backend

중앙 서버.

담당 기능:
- 사용자
- 친구
- Presence
- Room
- Room Member
- WebSocket
- Chat
- Playback State
- Sync authority
- 알림
- 개인정보 설정
- 차단

권장 기술:
- Java 21
- Spring Boot
- Spring Security
- Spring Data JPA
- Spring WebSocket
- MySQL
- Redis는 필요해질 때 도입

---

## 3. 서비스 원칙

1. Mirattic 서버는 영상/음성을 저장하거나 중계하지 않는다.
2. 사용자는 각 스트리밍 플랫폼에 직접 로그인한다.
3. Netflix / Laftel 로그인 정보, 쿠키, 세션 토큰을 Mirattic 서버에 저장하지 않는다.
4. Mirattic은 `현재 콘텐츠 + 위치 + 재생 상태` 같은 동기화 메타데이터만 다룬다.
5. DRM, 지역 제한, 동시 재생 제한을 우회하지 않는다.
6. YouTube는 공식 플레이어 정책을 준수한다.
7. Netflix / Laftel은 공개 playback API가 없으므로 DOM/플레이어 구조 변경에 대비해 Adapter 계층을 완전히 분리한다.
8. 플랫폼별 지원 범위가 다를 수 있음을 제품 UX에 명확히 표현한다.

---

## 4. 핵심 사용자 흐름

### 4.1 친구 상태 확인

Desktop App 친구 목록:

```text
● Giseok
Netflix
흑백요리사 EP.5 시청 중
24:03

[같이 보기]
```

Privacy 설정에 따라 위치는 숨길 수 있다.

예:

```text
친구 목록에서는:
Netflix · 흑백요리사 시청 중

Room에 참가한 뒤:
EP.5 · 24:03 / 51:22
```

### 4.2 같이 보기

1. 사용자 A가 Netflix / Laftel / YouTube에서 콘텐츠 시청
2. Extension이 현재 콘텐츠 및 상태 감지
3. Desktop App의 Presence가 갱신됨
4. 친구 B가 `[같이 보기]` 선택
5. 해당 Room이 없으면 임시 Room 생성
6. 친구 B 브라우저에서 같은 콘텐츠 페이지 열기
7. B가 각 플랫폼에서 정상적인 이용 권한으로 콘텐츠를 재생
8. Sync 시작
9. 이후 host의 play / pause / seek를 참가자가 따라감

---

## 5. Presence

### 5.1 상태

```text
OFFLINE
ONLINE
WATCHING
IN_ROOM
DND
```

### 5.2 MediaPresence

```ts
type MediaProvider = "youtube" | "netflix" | "laftel";

type MediaPresence = {
  provider: MediaProvider;
  contentId?: string;
  title: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  thumbnailUrl?: string;
  canonicalUrl?: string;
  positionMs?: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
};
```

### 5.3 공개 범위

```text
시청 상태 공유
- OFF
- FRIENDS
- ROOM_ONLY

상세 위치 공유
- OFF
- ROOM_ONLY
- FRIENDS
```

기본값은 보수적으로 설정한다.

---

## 6. Room 모델

### Room

```text
id
name
ownerId
visibility
createdAt
```

초기 visibility:
- PRIVATE
- FRIENDS_ONLY

추후:
- PUBLIC

### RoomMember

```text
roomId
userId
joinedAt
role
syncMode
```

role:
- HOST
- MEMBER

syncMode:
- FOLLOW_HOST
- INDEPENDENT

초기 MVP는 FOLLOW_HOST만 지원해도 된다.

---

## 7. Playback Sync

### 7.1 공통 상태

```ts
type PlaybackState = {
  provider: MediaProvider;
  contentId: string;
  positionMs: number;
  durationMs?: number;
  playing: boolean;
  capturedAt: number;
  sourceUserId: string;
  version: number;
};
```

### 7.2 authoritative model

초기 MVP에서는 Host authoritative 방식.

Host에서:
- play
- pause
- seek
- 콘텐츠 변경

이 발생하면 Room state를 갱신한다.

### 7.3 position 계산

```text
positionMs = 1,432,000
capturedAt = T

현재 시각 = T + 900ms
playing = true

예상 위치 = 1,432,900ms
```

### 7.4 drift 보정

초기 기준 예시:

```text
< 500ms      무시
500~1500ms   유지 또는 다음 sync에서 재확인
> 1500ms     seek 보정
> 3000ms     즉시 강제 보정
```

플랫폼마다 seek 정확도가 다르므로 provider별 threshold override를 허용한다.

---

## 8. Browser Extension Provider 구조

플랫폼별 구현을 완전히 분리한다.

```text
providers/
  core/
  youtube/
  netflix/
  laftel/
```

공통 인터페이스 예:

```ts
interface MediaProviderAdapter {
  provider: MediaProvider;

  detect(): boolean;
  getPresence(): Promise<MediaPresence | null>;
  getPlaybackState(): Promise<PlaybackState | null>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  onPlaybackChanged(callback: (state: PlaybackState) => void): () => void;
  destroy(): void;
}
```

UI / WebSocket 코드에서 Netflix DOM selector를 직접 사용하지 않는다.

---

## 9. YouTube Adapter

가능하면 공식 YouTube IFrame Player API 또는 공식적으로 허용된 player integration을 우선 사용한다.

지원 목표:
- 현재 videoId
- 제목
- currentTime
- duration
- player state
- play
- pause
- seek

주의:
- 플레이어 위에 Mirattic UI를 덮지 않는다.
- Mirattic Chat Panel은 플레이어 외부의 별도 영역에 표시한다.
- 광고나 기본 플레이어 기능을 가리지 않는다.

---

## 10. Netflix Adapter

공개 playback API가 없다는 전제에서 설계한다.

목표:
- Netflix 페이지/플레이어 감지
- 현재 작품/에피소드 식별
- 재생 위치
- duration
- playing/paused
- 사용자 입력에 따른 seek / play / pause

원칙:
- DRM에 접근하지 않는다.
- 네트워크 스트림을 가로채지 않는다.
- 계정 세션/쿠키를 서버로 보내지 않는다.
- 플레이어 DOM 또는 브라우저가 노출하는 정상 UI 계층만 다룬다.
- Netflix 페이지 구조가 변경되면 Adapter만 수정한다.

---

## 11. Laftel Adapter

Netflix와 동일한 원칙.

추가 고려:
- 시즌/에피소드 메타데이터 정규화
- 라프텔의 특정 시점 공유 URL이 있다면 canonicalUrl 생성에 활용 가능 여부 검토
- 동시 재생 회선 제한을 절대 우회하지 않는다.

---

## 12. Chat Panel

브라우저 확장이 영상 옆에 별도 사이드 패널을 삽입한다.

예:

```text
┌───────────────────────────────┬──────────────────┐
│                               │ Mirattic Sync    │
│                               │                  │
│          Video Player         │ Giseok  [24:31] │
│                               │ 여기 복선 같음   │
│                               │                  │
│                               │ Minsoo  [24:37] │
│                               │ 나도 그렇게 봄   │
│                               │                  │
│                               │ [메시지 입력]     │
└───────────────────────────────┴──────────────────┘
```

### 메시지 모델

```ts
type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  text: string;
  mediaPositionMs?: number;
  createdAt: string;
};
```

메시지 작성 시 현재 media position을 선택적으로 첨부.

### timestamp jump

`[24:31]` 클릭 시:

```text
24:31로 이동할까요?
[이동] [취소]
```

임의로 자동 seek하지 않는다.

---

## 13. Reaction

영상 특정 시점에 반응 가능.

```text
😂 x4 @ 24:32
🔥 x3 @ 25:10
```

초기:
- ❤️
- 😂
- 😮
- 😭
- 🔥

Reaction은 콘텐츠 위에 overlay하지 않고 Chat Panel 또는 타임라인 UI 안에 표시한다.

---

## 14. 친구 시스템

### 기능
- 사용자 검색
- 친구 요청
- 수락 / 거절
- 친구 삭제
- 차단
- 즐겨찾기 친구
- 온라인 / 시청 상태
- 같이 보기

### 소셜 UI

```text
Friends

● Giseok
  Netflix · 흑백요리사 시청 중
  [같이 보기]

● Minsoo
  YouTube · 침착맨 시청 중
  [같이 보기]

○ Jihun
  Offline
```

---

## 15. Desktop App 역할

Desktop App은 브라우저를 대체하지 않는다.

주요 역할:
- Social Home
- Friends
- Presence
- Room
- Invite
- Chat history
- Notifications
- Settings

추후:
- Tray
- Start on login
- 현재 친구 activity 간략 표시
- 같이 보기 알림

예:

```text
"민수가 Netflix에서 흑백요리사를 보고 있습니다."
[같이 보기]
```

---

## 16. Extension ↔ Desktop 통신

가능한 두 구조를 검토한다.

### A. Backend mediated

```text
Extension
  ↓ WebSocket
Backend
  ↓ WebSocket
Desktop
```

장점:
- 구현 단순
- 웹/다중 디바이스 확장 쉬움

### B. Local Bridge + Backend

```text
Extension
  ↓ localhost / native messaging
Desktop
  ↓ WebSocket
Backend
```

장점:
- Desktop이 로컬 브라우저 상태를 즉시 알 수 있음
- 민감한 세션 정보를 서버로 보낼 필요 없음

초기 MVP는 A로 시작해도 된다.
단, 스트리밍 서비스 인증정보/쿠키는 어떤 경우에도 Backend로 보내지 않는다.

---

## 17. Backend Domain

초기 Entity:

```text
User
FriendRequest
Friendship
BlockedUser
UserPresence
Room
RoomMember
RoomPlaybackState
ChatMessage
Reaction
Notification
```

영상 자체의 상세 카탈로그 DB는 초기에는 만들지 않는다.

필요하면 추후:

```text
MediaContent
MediaProviderMapping
```

을 도입한다.

---

## 18. WebSocket Event

예:

```text
presence:update

room:join
room:leave
room:invite

playback:update
playback:play
playback:pause
playback:seek
playback:content-change

sync:request
sync:response

chat:message
reaction:add
```

공통 envelope:

```ts
type SocketEvent<T> = {
  type: string;
  roomId?: string;
  userId: string;
  sentAt: number;
  version?: number;
  payload: T;
};
```

---

## 19. 개인정보와 보안

필수 원칙:

- 비밀번호 hash 저장
- JWT 또는 secure session
- Refresh Token rotation
- CSRF 방어
- WebSocket 인증
- Room membership 검증
- 친구 상태 접근 권한 검증
- Rate limiting
- CORS 제한
- secret은 환경변수
- 로그에 password/token/cookie/session 값 금지

특히:
- Netflix password 저장 금지
- Laftel password 저장 금지
- streaming provider cookie 저장 금지
- 브라우저 session token 서버 전송 금지

---

## 20. 플랫폼 정책 대응

각 Adapter 작업 전 반드시 최신 공식 정책을 확인한다.

문서화 대상:

```text
docs/platform-policy/
  youtube.md
  netflix.md
  laftel.md
```

각 문서에:
- 공식 API 존재 여부
- 허용된 플레이어 제어 범위
- 금지되는 동작
- 로그인/세션 취급
- 콘텐츠 재전송 금지
- 계정/회선 제한
- 구현에서 지켜야 할 원칙
- 확인 날짜

를 기록한다.

정책이 불확실한 기능은 기본 비활성화하고 TODO로 남긴다.

---

## 21. 수익화 방향

초기 MVP에서는 수익화를 구현하지 않는다.

추후에도 스트리밍 콘텐츠 접근 자체가 아니라 Mirattic 고유 기능에 과금하는 방향을 우선 검토한다.

예:
- 고급 프로필
- 대형 Room
- Room theme
- 친구 그룹
- 고급 알림
- 시청 기록
- 음성/영상 채팅

각 플랫폼 정책을 다시 검토한 뒤 도입한다.

---

## 22. 개발 Phase

### Phase 0 — Repository & Architecture

- monorepo 구성
- Desktop App shell
- Extension shell
- Backend shell
- shared packages
- 기본 CI
- README
- CLAUDE.md

완료 조건:
- 각 앱이 독립 실행
- 공통 타입 패키지 import 가능

### Phase 1 — Account / Friend / Presence

- 회원가입 / 로그인
- 친구 요청 / 수락 / 삭제
- Presence WebSocket
- Desktop 친구 목록

완료 조건:
- 두 계정 로그인
- 서로 친구 추가
- 온라인 상태 실시간 반영

### Phase 2 — Mock Media Provider

실제 스트리밍 서비스를 붙이지 않는다.

Mock player:
- Play
- Pause
- Seek
- Duration
- Fake content

두 클라이언트 Room 동기화.

완료 조건:
- Host 조작이 Member에게 반영
- drift 보정 동작

### Phase 3 — Extension Base

- content script
- service worker
- provider registry
- backend websocket 연결
- 기본 side panel

완료 조건:
- 지원 사이트에서 Extension 활성화 감지

### Phase 4 — YouTube

- YouTube Adapter
- 콘텐츠 감지
- play/pause/seek
- Room sync
- Chat Panel

완료 조건:
- 서로 다른 두 PC에서 YouTube 같이 보기

### Phase 5 — Desktop Integration

- 친구 시청 Presence
- `[같이 보기]`
- Room invite
- desktop notification
- tray

완료 조건:
- 친구가 보고 있는 콘텐츠에 Desktop에서 합류 가능

### Phase 6 — Netflix Experimental Adapter

공식 정책 재검토 후 진행.

- 작품/에피소드 감지
- currentTime
- play/pause/seek
- Presence
- Room sync

완료 조건:
- 각자 정상 Netflix 계정으로 같은 콘텐츠를 열고 상태 동기화

### Phase 7 — Laftel Experimental Adapter

Netflix와 동일하게 진행.

### Phase 8 — Chat / Reaction Polish

- timestamp message
- reaction
- history
- unread
- mute

### Phase 9 — Privacy / Safety

- Presence visibility
- block
- report
- Room permission
- delete account/data

### Phase 10 — Deployment

- Docker
- MySQL
- Caddy
- HTTPS
- Cloudflare
- Desktop installer
- Chrome Web Store 준비

---

## 23. MVP 범위

MVP에 반드시 포함:
- Mirattic 계정
- 친구
- Presence
- Room
- YouTube sync
- Chat Panel
- Desktop macOS/Windows
- Browser Extension

MVP에서 제외:
- 공개 Room
- 영상/음성 채팅
- 모바일 앱
- Safari
- Firefox
- 추천 알고리즘
- AI 기능
- 자체 스트리밍
- 콘텐츠 다운로드
- 결제
- 광고

Netflix / Laftel은 MVP 이후 experimental provider로 추가해도 된다.

---

## 24. 코드 구조 제안

```text
mirattic-sync/
  apps/
    desktop/
    extension/
    web/              # 선택 사항

  packages/
    types/
    api-client/
    websocket-client/
    media-core/
    ui/

  server/

  docs/
    architecture/
    platform-policy/
    protocol/

  CLAUDE.md
  README.md
```

Extension:

```text
apps/extension/src/
  core/
  providers/
    youtube/
    netflix/
    laftel/
  content/
  background/
  side-panel/
```

---

## 25. Phase 종료 규칙

각 Phase가 끝날 때 반드시:

1. 구현한 내용 요약
2. 변경 파일 목록
3. 테스트 결과
4. 현재 Architecture Decision
5. Known Issues
6. 남은 TODO
7. 다음 Phase 시작점

을 `docs/progress.md`에 업데이트한다.

Phase 종료 후 compact를 해도 작업을 이어갈 수 있도록 프로젝트 상태를 파일에 남긴다.

---

## 26. Claude Code 첫 지시

실제 코드를 바로 작성하지 말고 먼저 다음을 수행한다.

1. 이 기획서 검토
2. 기술적 위험 요소 정리
3. 최신 YouTube / Netflix / Laftel 정책 확인이 필요한 부분 표시
4. monorepo 구조 확정안 제시
5. Backend domain model 제안
6. WebSocket protocol 제안
7. MediaProviderAdapter interface 확정안 제안
8. Extension ↔ Backend ↔ Desktop 통신 구조 비교
9. Phase 0~4 세부 구현 계획 작성
10. 사용자 승인 후 Phase 0 시작
