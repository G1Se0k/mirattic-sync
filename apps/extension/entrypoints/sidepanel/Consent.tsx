import { useState } from 'react';
import { browser } from 'wxt/browser';
import { CONSENT_KEY, CONSENT_VERSION } from '../../consent';

export { hasConsent } from '../../consent';

/**
 * Prominent disclosure required by the Chrome Web Store user data policy before any browsing activity
 * (what the user watches) is read or sent. Nothing connects to a YouTube tab until this is accepted.
 */
export function Consent({ onAccept }: { onAccept: () => void }) {
  const [declined, setDeclined] = useState(false);

  async function accept() {
    await browser.storage.local.set({ [CONSENT_KEY]: CONSENT_VERSION });
    onAccept();
  }

  return (
    <main className="container">
      <h1>시작하기 전에</h1>
      <p>Mirattic Sync는 친구와 같은 영상을 함께 보기 위해 아래 정보를 Mirattic 서버로 보냅니다.</p>
      <ul>
        <li><strong>계정</strong>: 이메일, 표시 이름, 친구 목록</li>
        <li><strong>채팅</strong>: 같이 보기 방에서 보낸 메시지와 방 기록(입장·퇴장, 호스트의 재생·일시정지·이동), 신고한 내용 (메시지와 계정은 언제든 삭제할 수 있습니다)</li>
        <li>
          <strong>시청 정보</strong>: YouTube 탭에서 보고 있는 영상의 ID, 제목, 채널 이름, 재생 위치와 재생 상태.
          친구에게 보이는 범위는 "공개 범위" 설정을 따르고, 같이 보기 방의 동기화에 쓰입니다.
        </li>
      </ul>
      <p className="muted">
        Netflix·Laftel은 설치 때 접근 권한을 받지만, 설정에서 제어를 켜기 전에는 지금 탭이 그 사이트인지만 확인해 켤지
        안내합니다(서버로 보내지 않음). 켜면 그 사이트의 시청 정보도 위와 같이 보냅니다.
      </p>
      <p className="muted">
        YouTube 비밀번호·쿠키·로그인 정보, 다른 사이트 방문 기록, 영상 자체는 읽거나 보내지 않습니다.
        광고, 판매, 제3자 제공에 쓰지 않습니다.
      </p>
      {declined && <p className="error">동의하지 않으면 Mirattic Sync를 사용할 수 없습니다. 언제든 다시 선택할 수 있습니다.</p>}
      <div className="row">
        <button onClick={accept}>동의하고 시작</button>
        <button className="link" onClick={() => setDeclined(true)}>동의하지 않음</button>
      </div>
    </main>
  );
}
