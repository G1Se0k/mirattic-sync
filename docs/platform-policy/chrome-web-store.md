# Chrome Web Store / Chrome Extension 정책

확인 날짜: 2026-09-28 (Phase 3 시작 시)

## 출처 (공식)
- Program Policies: https://developer.chrome.com/docs/webstore/program-policies/policies
- User Data FAQ: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- `chrome.storage`: https://developer.chrome.com/docs/extensions/reference/api/storage
- Service worker 수명: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Manifest `key`: https://developer.chrome.com/docs/extensions/reference/manifest/key

## 공식 API 여부
해당 없음 (Chrome 확장 플랫폼 자체의 정책). provider별 정책은 `youtube.md` 등에서 따로 확인한다.

## 요약
| 항목 | 정책 내용 | 우리 구현 |
|---|---|---|
| 단일 목적 | "single purpose that is narrow and easy to understand" | 친구와 같이 보기 (재생 상태 동기화 + 채팅) 하나 |
| 최소 권한 | "narrowest permissions necessary" | `sidePanel`, `storage` + `https://www.youtube.com/*`(content script와 같은 범위의 host_permissions, Phase 4). Phase 6: `scripting` + Netflix, Phase 7: Laftel — 처음엔 선택 권한이었으나 2026-09-29 결정 81(사용자 결정)로 `https://www.netflix.com/*`, `https://laftel.net/*`를 설치 때 받는 권한으로 바꿈: 제어가 꺼져 있어도 그 사이트 탭에 들어간 것을 알아채 켤지 안내하기 위함. 제어(페이지 읽기·스크립트 주입)는 여전히 사용자가 켤 때만. 스토어 제출 시 이 두 권한의 사용 목적 설명 필요. API 서버는 CORS로 extension origin 허용 |
| 원격 코드 | MV3는 외부에서 실행 로직을 불러오면 안 됨. 데이터는 가능 | 모든 코드는 번들에 포함. 서버에서는 JSON만 받음 |
| 사용자 데이터 범위 | 이름·이메일, 인증 정보, **웹 브라우징 활동**(보고 있는 사이트/콘텐츠) 모두 포함. 로컬 처리만 해도 공개 대상 | 계정(이메일·표시 이름), 친구 목록, 재생 상태. Phase 4부터 "시청 중인 콘텐츠" = 브라우징 활동 |
| 개인정보처리방침 | 사용자 데이터를 다루면 대시보드에 게시 필수 | `docs/legal/privacy-policy.md`, 게시 주소 https://sync.mirattic.com/privacy.html (2026-09-29) |
| 눈에 띄는 공개 + 동의 | 수집 전에 **제품 UI 안에서** 공개하고 동의를 받아야 함. 스토어 설명으로는 부족 | side panel 첫 화면에서 공개 + 동의 (Phase 4, `Consent.tsx`). 동의 전에는 YouTube 탭에 연결하지 않음. 공개 범위 기본값도 보수적(presence=FRIENDS, 위치=ROOM_ONLY) |
| 전송 / 저장 | HTTPS·WSS로 전송, 저장 시 강력한 암호화 | 운영은 https/wss 필수 (dev만 localhost http). 아래 토큰 저장 참고 |
| Limited Use | 기능 제공 목적 외 사용·판매·광고 금지, 사람이 열람 제한 | 광고/분석 없음. 서버 로그에 토큰·재생 데이터 남기지 않음 |
| 저작권 / 접근 제어 | 유료벽·로그인 제한 우회, 저작물 무단 접근·다운로드·스트리밍 조장 금지 | 미디어를 전송하지 않음. 각 사용자가 자기 계정으로 직접 재생 (CLAUDE.md 규칙) |

## 로그인 / 세션 취급 (결정)
- Extension은 Mirattic 계정으로 별도 로그인 (provider 계정 정보는 다루지 않음)
- refresh token은 **`chrome.storage.local`** (결정 68, 2026-09-29 사용자 요청으로 자동 로그인. 이전: `storage.session`, 결정 30)
  - 브라우저를 다시 열어도 로그인 유지
  - `setAccessLevel('TRUSTED_CONTEXTS')`로 확장 페이지만 읽음 (content script 접근 불가). 설정에 실패하면 읽지도 저장하지도 않음
  - 대가: Chrome 프로필 디스크에 평문 → "저장 시 암호화" 요건 관점에서 약해짐. 서버가 사용할 때마다 교체하고 재사용 시 family 폐기, 로그아웃 · 계정 삭제 시 지움. 스토어 제출 전 재검토
- access token은 side panel 메모리에만

## 서비스 워커 수명
- 30초간 이벤트가 없으면 종료. Chrome 116+에서는 WebSocket 메시지 송수신이 idle 타이머를 초기화하지만, 서버가 보낼 것이 없으면 종료될 수 있음
- → WebSocket은 background가 아니라 side panel 페이지가 가짐 (`plan.md` 결정 29)

## 확장 ID 고정
- manifest `key`에 스토어 항목의 공개키를 넣어 ID `ffoifpjldcgdiipbhljkofgifmefgohk` 고정 (2026-09-29, 이전 dev ID `kphihploboaigagpahhdhjiaglnfmpii` 대체) → 서버 `ALLOWED_ORIGINS`·`AUTH_EXTENSION_REDIRECTS` 기본값에 포함
- 스토어 업로드는 `key`를 거부함 ("key 입력란은 매니페스트에 허용되지 않습니다") → 업로드용 zip은 manifest.json에서 `key`를 뺀 것 사용. 압축해제 설치용은 `key` 유지

## 불확실한 항목
- side panel에서 `confirm()`/`alert()` 동작: Playwright(Chromium 탭으로 연 side panel 페이지)에서는 동작 확인. 실제 side panel 컨테이너에서는 미확인
- "눈에 띄는 공개"의 구체적 문구·화면 요건은 심사 기준이 공개돼 있지 않음 → 보수적으로 처음 사용 시 별도 동의 화면
