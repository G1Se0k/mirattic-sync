import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, connectSocket, type SocketStatus } from "@mirattic/client";
import type { FriendRequests, FriendView, Me, PresenceView, UserSummary } from "@mirattic/types";
import { api, SOCKET_URL } from "./session";
import { Privacy } from "./Privacy";

type Props = { me: Me; onMeChange: (me: Me) => void; onSignedOut: () => void };

export function Home({ me, onMeChange, onSignedOut }: Props) {
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [blocked, setBlocked] = useState<UserSummary[]>([]);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [f, r, b] = await Promise.all([api.friends(), api.friendRequests(), api.blocked()]);
      setFriends(f);
      setRequests(r);
      setBlocked(b);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    }
  }, [onSignedOut]);

  useEffect(() => {
    const socket = connectSocket({
      url: SOCKET_URL,
      getTicket: api.wsTicket,
      onStatus: (s) => {
        setStatus(s);
        if (s === "open") void reload(); // catch up on anything missed while disconnected
      },
      onEvent: (event) => {
        if (event.type === "friend:update") void reload();
        if (event.type === "presence:update" && event.userId) {
          const presence = event.payload as PresenceView;
          setFriends((list) => list.map((f) => (f.user.id === event.userId ? { ...f, presence } : f)));
        }
      },
    });
    return () => socket.close();
  }, [reload]);

  // Every action refetches; the other side learns via `friend:update`.
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요청에 실패했습니다.");
    }
    await reload();
  };

  const sorted = [...friends].sort((a, b) => rank(a.presence) - rank(b.presence));

  return (
    <main className="container">
      <header className="row between">
        <h1>Friends</h1>
        <div className="row">
          <span className={`dot ${status === "open" ? "on" : ""}`} title={status} />
          <span className="muted">{me.displayName}</span>
          <button className="link" onClick={onSignedOut}>로그아웃</button>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      <section>
        {sorted.length === 0 && <p className="muted">아직 친구가 없습니다.</p>}
        <ul className="list">
          {sorted.map((f) => (
            <li key={f.user.id} className="friend">
              <span className={`dot ${f.presence.status !== "OFFLINE" ? "on" : ""}`} />
              <div className="grow">
                <strong>{f.user.displayName}</strong>
                <div className="muted">{describe(f.presence)}</div>
              </div>
              <button className="link" onClick={act(() => api.removeFriend(f.user.id))}>삭제</button>
              <button className="link danger" onClick={act(() => api.block(f.user.id))}>차단</button>
            </li>
          ))}
        </ul>
      </section>

      {(requests.incoming.length > 0 || requests.outgoing.length > 0) && (
        <section>
          <h2>친구 요청</h2>
          <ul className="list">
            {requests.incoming.map((r) => (
              <li key={r.id} className="friend">
                <span className="grow">{r.user.displayName}</span>
                <button onClick={act(() => api.acceptFriendRequest(r.id))}>수락</button>
                <button className="link" onClick={act(() => api.deleteFriendRequest(r.id))}>거절</button>
              </li>
            ))}
            {requests.outgoing.map((r) => (
              <li key={r.id} className="friend">
                <span className="grow">{r.user.displayName} <span className="muted">· 대기 중</span></span>
                <button className="link" onClick={act(() => api.deleteFriendRequest(r.id))}>취소</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <MyFriendCode me={me} onMeChange={onMeChange} />
      <AddFriend onSent={reload} />
      <Privacy me={me} onChange={onMeChange} />

      {blocked.length > 0 && (
        <section>
          <h2>차단한 사용자</h2>
          <ul className="list">
            {blocked.map((u) => (
              <li key={u.id} className="friend">
                <span className="grow">{u.displayName}</span>
                <button className="link" onClick={act(() => api.unblock(u.id))}>차단 해제</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function MyFriendCode({ me, onMeChange }: { me: Me; onMeChange: (me: Me) => void }) {
  const [copied, setCopied] = useState(false);
  const code = formatCode(me.friendCode);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate() {
    if (!confirm("새 코드를 발급하면 지금 코드로는 더 이상 친구 요청을 받을 수 없습니다. 계속할까요?")) return;
    await api.regenerateFriendCode().then(onMeChange, () => {});
  }

  return (
    <section>
      <h2>내 친구 코드</h2>
      <div className="row">
        <code className="code grow">{code}</code>
        <button onClick={copy}>{copied ? "복사됨" : "복사"}</button>
        <button className="link" onClick={regenerate}>새로 발급</button>
      </div>
      <p className="muted">친구에게 이 코드를 알려주면 친구 요청을 받을 수 있습니다.</p>
    </section>
  );
}

function AddFriend({ onSent }: { onSent: () => void }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const user = await api.sendFriendRequest(code);
      setNote(`${user.displayName}님에게 요청을 보냈습니다.`);
      setCode("");
      onSent();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setNote(
        status === 404 ? "해당 코드의 사용자를 찾을 수 없습니다."
          : status === 409 ? "이미 친구이거나 요청을 보낸 사용자입니다."
          : status === 400 ? "내 코드로는 요청할 수 없습니다."
          : "요청에 실패했습니다.",
      );
    }
  }

  return (
    <section>
      <h2>친구 추가</h2>
      <form className="row" onSubmit={submit}>
        <input className="grow code" placeholder="친구 코드 (예: K7QM-4XPR)" required maxLength={16}
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit">요청</button>
      </form>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}

function formatCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const PROVIDER_NAMES = { youtube: "YouTube", netflix: "Netflix", laftel: "Laftel" } as const;

function describe(p: PresenceView) {
  if (p.status === "OFFLINE") return "오프라인";
  if (!p.media) return "온라인";
  const m = p.media;
  const title = m.episodeTitle ? `${m.title} · ${m.episodeTitle}` : m.title;
  const position = m.positionMs !== undefined ? ` · ${clock(m.positionMs)}` : "";
  return `${PROVIDER_NAMES[m.provider]} · ${title} ${m.playing ? "시청 중" : "일시정지"}${position}`;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function rank(p: PresenceView) {
  return p.status === "WATCHING" ? 0 : p.status === "ONLINE" ? 1 : 2;
}
