import { useState } from "react";
import { ApiError } from "@mirattic/client";
import { api } from "./session";

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
      if (status !== 0) setError(status === 429 ? "요청이 너무 많습니다. 잠시 후 다시 시도하세요." : "로그인하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <h1>Mirattic Sync</h1>
      <div className="stack">
        <button onClick={signIn} disabled={busy}>Mirattic 계정으로 로그인</button>
        <p className="muted">계정이 없으면 열리는 창에서 만들 수 있습니다.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
