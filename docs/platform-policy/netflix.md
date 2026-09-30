# Netflix 정책

확인 날짜: 2026-09-28 (Phase 6 시작 시)

## 출처 (공식)
- Netflix 이용약관 (Last Updated: April 10, 2026): https://help.netflix.com/legal/termsofuse (한국어: `?locale=ko-KR`, 조항 내용 동일)
- 지원 브라우저: https://help.netflix.com/en/node/30081
- 확장 프로그램으로 인한 오류 안내 (M7353-5101, UI3013): https://help.netflix.com/en/node/101923 , https://help.netflix.com/en/node/134171

## 공식 API 여부
- 없음. 공개 playback / 제어 API, 파트너 프로그램 공개 문서 없음
- 공식 watch party 기능이나 제3자 확장을 허용한다는 안내도 찾지 못함 (Help Center 검색 기준)

## 관련 조항 (1.8 Usage Rights and Restrictions)
"Unless otherwise explicitly authorized, you agree not to:"
- (iii) "circumvent, remove, alter, deactivate, degrade, block, obscure or thwart any of the content protections or other elements of the Netflix service including the graphical user interface, …"
- (iv) "use any robot, spider, scraper or other automated means to access the Netflix service"
- (v) "decompile, reverse engineer or disassemble any software or other products or processes accessible through the Netflix service"
- (vi) "**insert any code or product or manipulate the content of the Netflix service in any way**"
- (vii) "use any data mining, data gathering or extraction method"
- "We may terminate or restrict your use of our service if you violate … 1.8 …" — 위반 시 불이익은 **사용자 계정**에 돌아감

기타: 1.4 계정은 가구 밖과 공유 금지, 1.5 동시 시청 기기 수는 요금제에 따름 · 계정 국가 기준 이용.

## 해석
YouTube 약관("interfere", "automated means")보다 훨씬 구체적이다.
- netflix.com 페이지에 content script를 넣는 것 자체가 (vi) "insert any code"에 문자 그대로 해당할 수 있음
- 제목·에피소드를 DOM에서 읽는 것은 (vii) 데이터 수집으로 볼 여지
- `video.currentTime` 직접 변경은 Netflix 플레이어 오류(M7375)를 일으키는 것으로 알려져 있고, 이를 피하는 알려진 방법은
  Netflix 내부 page-world 플레이어 API 호출 → (v) 리버스 엔지니어링 성격. 처음에는 사용하지 않았으나 **2026-09-29 사용자 결정으로 seek에 한해 사용** (plan.md 결정 66, 아래 "결정 변경")
- Teleparty 등 기존 확장이 있지만 Netflix가 허용했다는 공식 근거는 없음 → 근거로 삼지 않음

→ **정책이 불명확함 (CLAUDE.md 규칙: 보수적 구현)**. 구현 범위는 아래 "결정".

## 금지 동작 (어떤 선택이든 구현하지 않음)
- Netflix 내부 JS API / page-world 스크립트 호출 (**예외: 결정 66의 seek, 결정 73의 재생 정보(작품명·시즌·화·작품 ID) 읽기**), 네트워크 요청 가로채기, 매니페스트·자막·스트림 접근
- DRM(Widevine) 관련 모든 것, 화면 캡처, 재전송
- 페이지 DOM에 UI 삽입, 플레이어 가림. 예외 (2026-09-30 결정 87, 사용자 결정): 초대·합류 요청·일시정지 요청 알림과 그 응답 버튼(수락/거절)을 영상 오른쪽 위에 30초 표시 (플레이어는 조작하지 않음). 사이드 패널이 닫혀 있을 때만(열리면 모두 지움), 전체화면이면 전체화면 요소 위, 아니면 화면에 보이는 가장 큰 `<video>` 위. 읽는 것: 전체화면 여부, `<video>`의 화면 위치·크기
- 쿠키·세션·프로필 정보 읽기
- 사용자가 없는 탭 자동 재생·자동 이동

## 로그인 / 세션 취급
- 각 사용자가 자기 Netflix 계정으로 브라우저에서 직접 로그인. Mirattic은 아무것도 읽거나 저장하지 않음

## 재전송 금지
- 서버로 가는 것은 Netflix 콘텐츠 ID(URL `/watch/<숫자>`)와 재생 상태 메타데이터뿐 (결정 73부터: 재생 정보에서 읽은 작품명·시즌·화·에피소드 제목, 또는 플레이어 제목 줄의 제목도 보내며, 공개 범위 설정대로 친구·방에 공유됨)

## 계정 / 회선 제한
- 멤버마다 자기 계정 필요. 계정 공유·동시 시청 제한을 우회하는 기능 없음
- 지역에 따라 같은 콘텐츠 ID가 없을 수 있음 → 볼 수 없는 멤버는 볼 수 없음 (우회 안내 없음)

## 결정 (2026-09-28, 사용자 선택: 실험적 제어, 기본 꺼짐)
- **기본 꺼짐.** 꺼져 있으면 netflix.com에 아무 코드도 넣지 않고, 활성 탭이 Netflix인지만 확인하며 페이지 내용은 읽지 않음
  - (2026-09-29 결정 81로 바뀜) `https://www.netflix.com/*`는 설치 때 받는 `host_permissions`. 켜고 끄는 것은 확장 설정(`storage.local`). 꺼져 있으면 지금 탭이 netflix.com인지만 보고(켤지 안내, 서버로 보내지 않음) 스크립트를 넣지 않음
  - content script는 manifest에 등록하지 않고, side panel이 **따라가는 Netflix 탭 하나에만** `scripting.executeScript`로 넣음
- 켜는 곳: 설정의 "실험 기능", Netflix 방에 처음 들어갈 때 뜨는 팝업. 둘 다 약관 조항과 계정 제한 위험을 보여준 뒤 사용자가 직접 켬
- 읽는 것: URL의 콘텐츠 ID(`/watch/<숫자>`), 탭 제목, `<video>`의 재생 상태, 그리고 결정 73부터 재생 정보(Netflix 내부 데이터의 작품명·시즌·화·에피소드 제목·작품 ID)와 플레이어 제목 줄(`[data-uia="video-title"]`). 그 밖의 페이지 DOM은 읽지 않음. (처음 결정: 에피소드 제목 등 페이지 DOM은 읽지 않음 — 결정 73으로 바뀜)
- 제어: 재생 / 일시정지는 `<video>`로. seek는 **Netflix 내부 플레이어 API로** (결정 변경, 아래). 결정 76부터: 방을 따라가는 멤버의 탭에서 끝 화면의 "크레딧 보기" 버튼을 눌러 혼자 다음 화로 넘어가지 않게 함
  - `currentTime` 쓰기는 Netflix가 막고 재생 오류(M7375)를 띄움 (확장 개발자들의 공개 이슈로 확인, 아래 출처)
  - 내부 API 호출이 실패하면 (Netflix 변경) 그 탭은 예전처럼 멤버에게 "호스트와 N초 차이 · mm:ss로 직접 이동" 안내

## 결정 변경 (2026-09-29, 사용자 결정)
- 처음 결정(Phase 6, 결정 47): seek하지 않음. 피하는 방법이 내부 API뿐이라 금지 동작으로 분류
- 변경(결정 66): 사용자(프로젝트 소유자)가 "Teleparty도 그렇게 운영한다"는 이유로 내부 API seek를 기본 동작으로 결정 (Netflix 제어를 켠 사용자에게)
- 범위: side panel이 따라가는 Netflix 탭 하나에만 `scripting.executeScript({ world: "MAIN" })`로 `netflix.appContext.state.playerApp.getAPI().videoPlayer…seek(ms)` 호출, 결정 73부터 같은 방식으로 재생 정보 읽기(화마다 한 번, 읽기만). 페이지의 다른 내부 기능 · DOM · 네트워크 · DRM에는 손대지 않음
- 남은 위험: 약관 1.8 (v)(vi) 위반 소지가 더 직접적 → 사용자 계정 제한 가능. 제3자 계약 위반 유도 쟁점. Teleparty의 존재는 Netflix가 허용했다는 근거가 아님. 켜기 안내 문구에 내부 기능 사용과 계정 위험을 적음
- 스토어 공개 전 법률 검토 항목에 이 변경 포함
- 추가 (2026-09-29, 결정 73, 사용자 요청): 무엇을 보는지 표시하려고 같은 내부 데이터에서 작품명·시즌·화·에피소드 제목·작품 ID를 읽음 (따라가는 탭 하나, 화마다 한 번). 페이지의 다른 데이터·DOM·네트워크는 읽지 않음. 읽은 제목은 공개 범위 설정대로 친구·방에 공유
- 광고 요금제: 광고 감지 방법(DOM)이 확인되지 않아 미지원. 켜기 팝업에서 알림
- 채팅은 YouTube와 같이 side panel 안 (Teleparty도 Netflix에서 별도 창을 쓰지 않음). 페이지 안에는 아무것도 넣지 않음

M7375 관련 공개 이슈 (공식 문서 아님):
- https://github.com/asbplayer/asbplayer/issues/631
- https://github.com/Nitrino/easysubs/issues/252
- https://github.com/MALSync/MALSync/issues/1537

## 법률 검토 체크리스트 (법률 자문 아님 — 스토어 공개 전 변호사 검토 필수)
| 항목 | 쟁점 | 현재 설계 | 공개 전 확인 |
|---|---|---|---|
| Netflix 약관 1.8(vi)(vii) (계약) | 약관 당사자는 사용자. 위반 시 **사용자 계정** 제한·해지 가능 | 기본 꺼짐, 조항 원문과 위험을 보여준 뒤 옵트인, 읽는 정보 최소화 | 옵트인 경고 문구가 충분한지 |
| 제3자 계약 위반 유도 (한국 민법 750조 제3자 채권침해 / 미국 tortious interference) | 약관 위반을 유도하는 제품을 배포한 회사의 책임 | 실험 기능·비홍보, 스토어 설명에서 Netflix 지원을 내세우지 않음 | 판례상 책임 요건, Netflix 공식 입장 (파트너 문의 여부) |
| 기술적 보호조치 무력화 (저작권법 104조의2 / DMCA §1201) | DRM·접근 통제 우회 | DRM·스트림·내부 API에 손대지 않음. 재생/일시정지 명령과 메타데이터만 | 해당 없음 확인 |
| 정보통신망법 48조 (무단 접근) | 권한 없는 접근 | 사용자 본인 계정·본인 브라우저 탭. 서버는 Netflix에 접근하지 않음 | 해당 없음 확인 |
| 개인정보보호법 / Chrome 사용자 데이터 정책 | 시청 정보 = 개인정보·브라우징 활동 | 켤 때 무엇을 읽고 보내는지 공개 + 동의, 공개 범위 설정 그대로 | 개인정보처리방침에 Netflix 항목 (Phase 10) |
| Chrome Web Store: "Do not facilitate unauthorized access to content …", "Do not encourage, facilitate, or enable the unauthorized access, download, or streaming of copyrighted content" (Program Policies, 2025-05-22) | 무단 접근·스트리밍 조장 | 각자 자기 계정으로 재생, 미디어 전송 없음 | 심사 거절 위험 — 스토어 빌드에서 Netflix 제외 옵션 |
| 상표 (Netflix 명칭·로고) | 제휴 오인 | 2026-09-29 결정 81(사용자 결정): 방 목록·지금 보는 영상에서 서비스 식별용으로 사용자가 준 로고를 작게(28px) 표시. 제휴·보증 문구 없음, 스토어 홍보 이미지에는 쓰지 않음 | 로고 사용 가이드라인 확인 필요 — 스토어 공개 전 검토 (YouTube·Laftel 로고도 같음) |

## 불확실한 항목
- **실제 Netflix 계정으로 검증하지 않음** (계정 없음). 가짜 netflix.com 페이지로만 E2E. `<video>` play/pause가 Netflix 플레이어 UI와 어긋나지 않는지, 탭 제목 형식, 다음 화 자동 재생 시 URL 변경은 실제 계정 확인 필요
- (vi)가 브라우저 확장 content script를 겨냥한 것인지 공식 설명 없음. 스토어 공개 전 법률 검토 필요
- 콘텐츠 ID가 국가별로 같은지 미확인
