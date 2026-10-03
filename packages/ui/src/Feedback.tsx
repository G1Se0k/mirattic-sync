import { useState, type FormEvent } from "react";
import { ApiError } from "@mirattic/client";
import { api } from "./session";
import { Actions, Dialog } from "./Dialog";

type Kind = "FEEDBACK" | "BUG";

/** Settings: feedback or a bug report, sent to the operators (decision 98). */
export function FeedbackSection() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>피드백 및 버그 리포트</h2>
      <button className="secondary" onClick={() => setOpen(true)}>의견 보내기</button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("FEEDBACK");
  const [text, setText] = useState("");
  const [state, setState] = useState<"edit" | "sending" | "sent">("edit");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setState("sending");
    setError(null);
    try {
      await api.feedback(kind, text.trim());
      setState("sent");
    } catch (err) {
      setState("edit");
      setError(err instanceof ApiError && err.status === 429 ? "오늘은 더 보낼 수 없습니다. 내일 다시 시도하세요." : "보내지 못했습니다.");
    }
  }

  return (
    <Dialog title="피드백 및 버그 리포트" onClose={onClose}>
      {state === "sent" ? (
        <>
          <p>보내 주셔서 감사합니다. 운영팀이 확인합니다.</p>
          <Actions><button onClick={onClose}>닫기</button></Actions>
        </>
      ) : (
        <form className="stack" onSubmit={submit}>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="FEEDBACK">의견 · 제안</option>
            <option value="BUG">버그 신고</option>
          </select>
          <textarea placeholder={kind === "BUG" ? "어떤 상황에서 무엇이 잘못되었는지 적어 주세요" : "의견을 적어 주세요"}
            maxLength={2000} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="muted">적은 내용과 계정이 운영팀에 전달됩니다. 비밀번호 등 민감한 정보는 적지 마세요.</p>
          <Actions>
            <button type="button" className="link" onClick={onClose}>취소</button>
            <button type="submit" disabled={state === "sending" || !text.trim()}>보내기</button>
          </Actions>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Dialog>
  );
}
