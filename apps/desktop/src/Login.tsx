import { useState, type FormEvent } from "react";
import { ApiError } from "@mirattic/client";
import { api } from "./session";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") await api.signup(email, password, displayName);
      else await api.login(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? message(err) : "서버에 연결할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <h1>Mirattic Sync</h1>
      <form className="stack" onSubmit={submit}>
        <input type="email" placeholder="이메일" autoComplete="email" required value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <input type="password" placeholder="비밀번호 (8자 이상)" required minLength={8} maxLength={128}
          autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {mode === "signup" && (
          <input placeholder="표시 이름" required maxLength={32} value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} />
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{mode === "signup" ? "가입하기" : "로그인"}</button>
      </form>
      <button className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
        {mode === "login" ? "계정이 없나요? 가입하기" : "이미 계정이 있나요? 로그인"}
      </button>
    </main>
  );
}

function message(err: ApiError) {
  if (err.status === 401) return "이메일 또는 비밀번호가 올바르지 않습니다.";
  if (err.status === 409) return "이미 가입된 이메일입니다.";
  if (err.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (err.status === 400) return "입력값을 확인하세요.";
  return err.message;
}
