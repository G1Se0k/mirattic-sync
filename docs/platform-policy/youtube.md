# YouTube 정책

확인 날짜: 2026-09-28 (Phase 4 시작 시)

## 출처 (공식)
- YouTube 서비스 약관 (영문, 시행일 2023-12-15): https://www.youtube.com/t/terms?hl=en&gl=US
- YouTube API Services Developer Policies (최종 수정 2026-09-14): https://developers.google.com/youtube/terms/developer-policies

## 공식 API 여부
- 공식 제어 API는 **IFrame Player API** (우리 페이지에 YouTube 플레이어를 임베드해 `playVideo/pauseVideo/seekTo`).
- 우리가 쓰는 방식은 API가 아니라, 사용자가 youtube.com에서 직접 연 탭의 `<video>`를 content script로 제어하는 것.
  Developer Policies는 "YouTube API Services를 사용하는" 클라이언트에 적용되므로 이 방식에 직접 적용되는지는 **불확실**.
- IFrame 임베드를 쓰지 않은 이유: 임베드 불가 영상이 있고, extension / Tauri origin에서는 Referer 요건 때문에 임베드가 실패할 수 있음. 또 사용자가 자기 YouTube 로그인 상태(프리미엄 등) 그대로 보려면 youtube.com 탭이 자연스러움.

## 관련 조항 (서비스 약관 "Permissions and Restrictions")
1. "access, reproduce, download, distribute, … alter, modify or otherwise use any part of the Service or any Content except … as expressly authorized"
2. "circumvent, disable, fraudulently engage with, or otherwise interfere with any part of the Service …, including security-related features or features that (a) prevent or restrict the copying or other use of Content or (b) limit the use of the Service or Content"
3. "access the Service using any automated means (such as robots, botnets or scrapers) except …"

Developer Policies (참고 기준으로 따름): 플레이어 기능 수정·차단 금지, **광고 수정·차단·가림 금지**, 오디오/비디오 분리 금지, 스크래핑 금지, 사용자 데이터 사용의 투명성.

## 허용된 플레이어 제어 범위 (우리의 보수적 해석)
- 사용자가 직접 연 youtube.com 탭에서, 사용자가 들어간 방의 호스트 조작에 맞춰 **재생 / 일시정지 / 위치 이동만** 한다. 사용자가 키보드로 하는 조작과 같은 범위.
- 사용자가 방에 들어가 있을 때만 제어. 방 밖에서는 읽기만 (presence, 동의 후).
- 다른 영상으로 이동은 자동으로 하지 않고, 사용자가 "이 영상 열기"를 눌렀을 때만.

## 금지 동작 (구현하지 않음)
- 광고 건너뛰기·숨기기·음소거·가리기, 광고 중 seek. 광고 중에는 동기화를 멈추고 호스트는 명령을 보내지 않는다
- 페이지 DOM에 UI 삽입 (플레이어를 가리지 않음, side panel만 사용). 예외 (2026-09-30 결정 87, 사용자 결정): 전체화면일 때만 초대·합류 요청·일시정지 요청 알림 글자를 오른쪽 위에 8초 표시 (누르면 닫힘, 전체화면을 나가면 사라짐)
- 미디어 URL / 스트림 추출, 다운로드, 재전송, 오디오/비디오 분리
- 댓글·추천 목록 등 페이지 데이터 수집 (읽는 것: URL의 영상 ID, 문서 제목, 플레이어 제목 링크 `#movie_player a.ytp-title-link`의 제목과 링크 속 영상 ID(지금 영상의 제목인지 확인용, 2026-09-29), `<video>`의 재생 상태, 영상 아래 채널 이름 `ytd-watch-flexy[video-id=지금 영상] ytd-video-owner-renderer ytd-channel-name a`의 글자(친구 목록 표시용, 2026-09-29 결정 80), 시크바 `#movie_player .ytp-progress-bar-container`를 누르고 있는지 여부만(누른 위치·다른 입력은 읽지 않음, 방 기록의 드래그 구분용, 2026-09-29 결정 86))
- 재생 속도 변경, 화질 변경, YouTube 내부 page-world API 호출
- 조회수 조작으로 볼 수 있는 자동 재생 반복 (사람이 없는 탭 자동 제어 안 함)

## 로그인 / 세션 취급
- YouTube 로그인은 사용자가 브라우저에서 직접. 쿠키·토큰을 읽거나 보내지 않음
- content script는 `https://www.youtube.com/*`에만

## 재전송 금지
- 서버로 보내는 것은 영상 ID, 제목, 채널 이름, 재생 위치·상태, 길이뿐. 각 사용자는 자기 YouTube에서 직접 재생

## 계정 / 회선 제한
- 해당 없음 (각자 자기 계정·무료 시청). 지역 제한 영상은 우회하지 않음 — 볼 수 없는 멤버는 볼 수 없음

## 구현 원칙
- DOM 선택자(`#movie_player`, `ad-showing`)는 `apps/extension/providers/youtube.ts` 안에만
- 영상 URL은 서버가 준 `canonicalUrl`이 아니라 검증된 영상 ID로 클라이언트가 만든다 (호스트가 임의 URL을 넣지 못하게)
- 브라우징 활동(무엇을 보는지)을 보내기 전에 side panel에서 공개 + 동의 (`chrome-web-store.md`)

## 불확실한 항목
- content script로 youtube.com `<video>`를 제어하는 것이 약관 2·3항("interfere", "automated means")에 해당하는지 공식 설명 없음.
  사용자가 직접 연 탭에서 사용자가 참여한 방의 조작만 반영하므로 자동화된 접근으로 보기는 어렵다고 판단하지만, **스토어 공개 전에 재검토** 필요. 문제가 되면 IFrame Player API 기반 웹 페이지로 전환
- YouTube 내부 구조(`#movie_player`, `ad-showing` 클래스)는 예고 없이 바뀔 수 있음
- 라이브 스트림, 재생 속도 변경, 프리미어는 동기화 대상에서 제외 (미검증)
