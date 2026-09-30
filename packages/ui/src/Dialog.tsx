import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Every popup looks the same (the "방 만들기" one): centered over a dimmed screen, a title, the content, and the
 * buttons at the bottom right — "취소"/"닫기" as a link first, the main action last. Escape or a click outside
 * closes it when `onClose` is given.
 */
export function Dialog({ title, children, onClose, alert }: {
  title: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  /** Needs an answer (a member's pause request): announced to screen readers as an alert. */
  alert?: boolean;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onClose) return;
    // Escape closes only the dialog on top (the last overlay in the page), not one hidden under it.
    const onKey = (e: KeyboardEvent) => {
      const all = document.querySelectorAll(".overlay");
      if (e.key === "Escape" && all[all.length - 1] === overlay.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div ref={overlay} className="overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <dialog open className="stack" role={alert ? "alertdialog" : "dialog"} aria-modal="true">
        <h2>{title}</h2>
        {children}
      </dialog>
    </div>
  );
}

/**
 * Time left, as a bar along the dialog's bottom edge that empties by `until` (epoch ms) out of `total` ms. Read
 * once when it mounts (a CSS animation from there): key it by what it times, so a new one starts over.
 */
export function TimeBar({ until, total }: { until: number; total: number }) {
  const [left] = useState(() => Math.max(0, Math.min(total, until - Date.now())));
  const style = { animationDuration: `${left}ms`, "--from": `${(left / total) * 100}%` } as CSSProperties;
  return (
    <div className="timebar" role="progressbar" aria-label="남은 시간" aria-valuemin={0} aria-valuemax={total}>
      <i style={style} />
    </div>
  );
}

/** The buttons row at the bottom of a dialog. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="row actions">{children}</div>;
}

type Question = { title: string; body?: string; ok: string; danger?: boolean; cancel: boolean; resolve: (yes: boolean) => void };

/** The app's own confirm() / alert(), as `Dialog`s: `ask` resolves true on the main button, `tell` on "확인". */
export function useAsk() {
  const [q, setQ] = useState<Question | null>(null);
  const answer = (yes: boolean) => {
    q?.resolve(yes);
    setQ(null);
  };
  const ask = (title: string, opts: { body?: string; ok?: string; danger?: boolean } = {}) =>
    new Promise<boolean>((resolve) => setQ({ title, body: opts.body, ok: opts.ok ?? "확인", danger: opts.danger, cancel: true, resolve }));
  const tell = (title: string, body?: string) =>
    new Promise<void>((resolve) => setQ({ title, body, ok: "확인", cancel: false, resolve: () => resolve() }));
  const dialog = q && (
    <Dialog title={q.title} onClose={() => answer(false)}>
      {q.body && <p className="muted">{q.body}</p>}
      <Actions>
        {q.cancel && <button className="link" onClick={() => answer(false)}>취소</button>}
        <button className={q.danger ? "danger" : undefined} autoFocus onClick={() => answer(true)}>{q.ok}</button>
      </Actions>
    </Dialog>
  );
  return { ask, tell, dialog };
}
