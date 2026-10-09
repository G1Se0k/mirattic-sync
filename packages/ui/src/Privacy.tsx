import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@mirattic/client";
import type { Me, Visibility } from "@mirattic/types";
import { api } from "./session";
import { useAsk } from "./Dialog";

export type SavePrivacy = (changes: Parameters<typeof api.updatePrivacy>[0]) => Promise<Me>;

/**
 * Privacy saves, one after another: each answer then holds every earlier change, so a slower, older answer never shows
 * over a newer one. Kept by Home, i.e. for one signed-in account: once it is gone (signed out) what waits isn't sent
 * and no answer is shown — never as or over another account. Leaving Settings keeps them.
 */
export function usePrivacySave(): SavePrivacy {
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return useCallback((changes) => {
    const closed = () => Promise.reject(new Error("settings closed"));
    const next = chain.current.then(() => (open.current ? api.updatePrivacy(changes) : closed()))
      .then((me) => (open.current ? me : closed()));
    chain.current = next.catch(() => {});
    return next;
  }, []);
}

const LABELS: Record<Visibility, string> = { OFF: "공유 안 함", FRIENDS: "친구", ROOM_ONLY: "같은 방에서만" };

export function Privacy({ me, save, onChange }: { me: Me; save: SavePrivacy; onChange: (me: Me) => void }) {
  // The playback position isn't a setting any more (decision 98: never shown to friends); the stored one is kept.
  const [failed, setFailed] = useState(false);
  // Saves answer in order (one after another): the last answer is the latest change's, success or not.
  const saved = (m: Me) => {
    setFailed(false);
    onChange(m);
  };
  const update = (presence: Visibility) => {
    setFailed(false);
    save({ presenceVisibility: presence }).then(saved, () => setFailed(true));
  };

  return (
    <label className="item">
      <span className="text">
        시청 중인 콘텐츠 공개
        <span className="muted">지금 보는 영상을 보여 줄 범위</span>
        {failed && <SaveError />}
      </span>
      <select value={me.presenceVisibility} onChange={(e) => update(e.target.value as Visibility)}>
          {(["FRIENDS", "ROOM_ONLY", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
      </select>
    </label>
  );
}

/** Who may ask me to be friends (decision 108): anyone in a room with me, or only those with my code. */
export function FriendRequestsFrom({ me, save, onChange }: { me: Me; save: SavePrivacy; onChange: (me: Me) => void }) {
  const [failed, setFailed] = useState(false);
  // Saves answer in order (one after another): the last answer is the latest change's, success or not.
  const saved = (m: Me) => {
    setFailed(false);
    onChange(m);
  };
  const update = (codeOnly: boolean) => {
    setFailed(false);
    save({ friendCodeOnly: codeOnly }).then(saved, () => setFailed(true));
  };
  return (
    <label className="item">
      <span className="text">
        친구 요청 받기
        <span className="muted">같은 방 멤버가 친구 코드 없이 요청할 수 있게 할지</span>
        {failed && <SaveError />}
      </span>
      <select value={me.friendCodeOnly ? "code" : "anyone"} onChange={(e) => update(e.target.value === "code")}>
        <option value="anyone">누구나</option>
        <option value="code">친구 코드로만</option>
      </select>
    </label>
  );
}

/** A privacy save failed: the control shows the setting still in force. */
function SaveError() {
  return <span className="error" role="alert">저장하지 못했습니다. 이전 설정이 그대로입니다. 다시 시도해 주세요.</span>;
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
    <div className="item">
      {asker.dialog}
      <span className="text">
        Mirattic Sync 데이터 삭제
        <span className="muted">Mirattic 계정 자체는 남고, Sync의 데이터만 삭제됩니다.</span>
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      <button className="link danger" onClick={remove} disabled={busy}>삭제…</button>
    </div>
  );
}
