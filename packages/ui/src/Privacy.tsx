import { useState } from "react";
import { ApiError } from "@mirattic/client";
import type { Me, Visibility } from "@mirattic/types";
import { api } from "./session";
import { useAsk } from "./Dialog";

const LABELS: Record<Visibility, string> = { OFF: "공유 안 함", FRIENDS: "친구", ROOM_ONLY: "같은 방에서만" };

export function Privacy({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  // The playback position isn't a setting any more (decision 98: never shown to friends); the stored one is sent back.
  const update = (presence: Visibility) => api.updatePrivacy(presence, me.positionVisibility).then(onChange, () => {});

  return (
    <section>
      <h2>공개 범위</h2>
      <label className="row between">
        시청 중인 콘텐츠
        <select value={me.presenceVisibility} onChange={(e) => update(e.target.value as Visibility)}>
          {(["FRIENDS", "ROOM_ONLY", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
        </select>
      </label>
    </section>
  );
}

/** Deletes the Sync profile and all its data after the Mirattic password is typed again (a sign-in window). */
export function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asker = useAsk();

  async function remove() {
    if (!(await asker.ask("계정을 삭제할까요?", {
      body: "친구·차단 목록, 내가 보낸 채팅 메시지, 신고·피드백 기록이 모두 삭제되고 내가 만든 방은 닫힙니다. 되돌릴 수 없습니다. 확인을 위해 Mirattic 계정 비밀번호를 한 번 더 입력합니다.",
      ok: "계정 삭제",
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      onDeleted();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : -1;
      if (status === 0) return; // the sign-in window was closed
      setError(status === 403 ? "본인 확인이 되지 않아 삭제하지 않았습니다. 이 계정으로 다시 로그인해 주세요."
        : status === 429 ? "잠시 후 다시 시도하세요." : "계정을 삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {asker.dialog}
      <h2>계정 삭제</h2>
      <p className="muted">Mirattic 계정 자체는 남고, Mirattic Sync의 데이터만 삭제됩니다.</p>
      <button className="link danger" onClick={remove} disabled={busy}>계정과 데이터 삭제…</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
