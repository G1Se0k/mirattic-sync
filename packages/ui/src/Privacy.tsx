import { useState, type FormEvent } from "react";
import { ApiError } from "@mirattic/client";
import type { Me, Visibility } from "@mirattic/types";
import { api } from "./session";

const LABELS: Record<Visibility, string> = { OFF: "공유 안 함", FRIENDS: "친구", ROOM_ONLY: "같은 방에서만" };

export function Privacy({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  const update = (presence: Visibility, position: Visibility) =>
    api.updatePrivacy(presence, position).then(onChange, () => {});

  return (
    <section>
      <h2>공개 범위</h2>
      <label className="row between">
        시청 중인 콘텐츠
        <select value={me.presenceVisibility} onChange={(e) => update(e.target.value as Visibility, me.positionVisibility)}>
          {(["FRIENDS", "ROOM_ONLY", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
        </select>
      </label>
      <label className="row between">
        재생 위치
        <select value={me.positionVisibility} onChange={(e) => update(me.presenceVisibility, e.target.value as Visibility)}>
          {(["ROOM_ONLY", "FRIENDS", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
        </select>
      </label>
    </section>
  );
}

/** Deletes the account and all its data after the password is typed again. */
export function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirm("계정을 삭제하면 되돌릴 수 없습니다. 삭제할까요?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      onDeleted();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 403 ? "비밀번호가 맞지 않습니다." : status === 429 ? "잠시 후 다시 시도하세요." : "계정을 삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>계정 삭제</h2>
      {!open ? (
        <button className="link danger" onClick={() => setOpen(true)}>계정과 데이터 삭제…</button>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted">
            계정, 친구·차단 목록, 내가 보낸 채팅 메시지, 신고 기록이 모두 삭제되고 내가 만든 방은 닫힙니다.
            다른 기기의 로그인도 모두 끝납니다.
          </p>
          <input type="password" placeholder="비밀번호 확인" autoComplete="current-password" required maxLength={128}
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="row">
            <button type="submit" className="danger" disabled={busy}>계정 삭제</button>
            <button type="button" className="link" onClick={() => { setOpen(false); setPassword(""); setError(null); }}>취소</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}
