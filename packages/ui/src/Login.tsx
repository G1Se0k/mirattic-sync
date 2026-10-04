import { useState } from "react";
import { ApiError } from "@mirattic/client";
import { api } from "./session";
import { Icon, ProviderIcon } from "./Icons";
import logo from "./assets/mirattic.png";

/** Sign-in and sign-up both happen on the Mirattic account page, in a browser window. */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await api.loginWithMirattic();
      onSignedIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : -1;
      // 0: the window was closed; nothing to report.
      if (status === 0) return;
      setError(status === 429 ? "요청이 너무 많습니다. 잠시 후 다시 시도하세요."
        : status === 502 ? "로그인 창을 열지 못했습니다. 인터넷 연결을 확인하거나 확장 프로그램을 최신 버전으로 업데이트하세요."
        : "로그인하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow login">
      <h1 className="mark">
        <img className="logo" src={logo} alt="" />
        <span className="wordmark">Mirattic <span>Sync</span></span>
      </h1>
      <p className="tagline">떨어져 있어도 같은 장면에서,<br />친구와 함께 보세요.</p>
      <ul className="points">
        <li><Icon name="check" />방장이 재생하면 모두의 영상이 함께 맞춰집니다</li>
        <li><Icon name="check" />옆 패널에서 채팅하고, 장면에 타임스탬프를 남기세요</li>
        <li><Icon name="check" />각자 자기 계정으로 봅니다 — 영상은 공유되지 않아요</li>
      </ul>
      <div className="row providers">
        <ProviderIcon provider="youtube" /><ProviderIcon provider="netflix" /><ProviderIcon provider="laftel" />
        <span className="muted">YouTube · Netflix · Laftel</span>
      </div>
      <div className="stack">
        <button onClick={signIn} disabled={busy}>Mirattic 계정으로 로그인</button>
        <p className="muted">계정이 없으면 열리는 창에서 만들 수 있습니다.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
