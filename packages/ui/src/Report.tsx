import { useState, type FormEvent } from "react";
import { ApiError } from "@mirattic/client";
import { REPORT_REASONS, type ReportReason, type ReportTarget } from "@mirattic/types";
import { api } from "./session";
import { Actions, Dialog } from "./Dialog";

type Props = {
  target: ReportTarget;
  /** Who is reported (the message's author), shown and offered to block afterwards. */
  user: { id: string; name: string };
  onClose: () => void;
};

/** Report dialog; after sending, offers to block the user too. */
export function ReportDialog({ target, user, onClose }: Props) {
  const [reason, setReason] = useState<ReportReason>("HARASSMENT");
  const [detail, setDetail] = useState("");
  const [state, setState] = useState<"edit" | "sending" | "sent" | "blocked">("edit");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    try {
      await api.report(target, reason, detail.trim() || undefined);
      setState("sent");
    } catch (err) {
      setState("edit");
      setError(err instanceof ApiError && err.status === 429 ? "오늘은 더 신고할 수 없습니다. 내일 다시 시도하세요." : "신고하지 못했습니다.");
    }
  }

  async function block() {
    try {
      await api.block(user.id);
      setState("blocked");
    } catch {
      setError("차단하지 못했습니다.");
    }
  }

  return (
    <Dialog title={"messageId" in target ? `${user.name}님의 메시지 신고` : `${user.name}님 신고`} onClose={onClose}>
      {state === "sent" || state === "blocked" ? (
        <>
          <p>신고가 접수되었습니다. 운영팀이 확인합니다.</p>
          {state === "blocked" ? <p className="muted">{user.name}님을 차단했습니다.</p> : (
            <p className="muted">차단하면 서로 친구·방에서 빠지고 다시 요청할 수 없습니다.</p>
          )}
          <Actions>
            <button className="link" onClick={onClose}>닫기</button>
            {state === "sent" && <button className="danger" onClick={() => void block()}>차단하기</button>}
          </Actions>
        </>
      ) : (
        <form className="stack" onSubmit={submit}>
          <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => <option key={r} value={r}>{REPORT_REASONS[r]}</option>)}
          </select>
          <textarea placeholder="자세한 내용 (선택)" maxLength={500} rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} />
          <p className="muted">{"messageId" in target ? "신고한 메시지 내용은 삭제되어도 운영팀 확인을 위해 보관됩니다." : "신고 사유와 내용이 운영팀에 전달됩니다."}</p>
          <Actions>
            <button type="button" className="link" onClick={onClose}>취소</button>
            <button type="submit" disabled={state === "sending"}>신고</button>
          </Actions>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Dialog>
  );
}
