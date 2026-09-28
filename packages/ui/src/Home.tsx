import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ApiError, connectSocket, type Socket, type SocketStatus } from "@mirattic/client";
import type {
  FriendRequests,
  FriendView,
  Me,
  PresenceView,
  RoomContent,
  RoomView,
  ServerEvent,
  UserSummary,
} from "@mirattic/types";
import { api, platform, SOCKET_URL } from "./session";
import { Privacy } from "./Privacy";
import { ExperimentalSettings } from "./Experimental";
import { Room } from "./Room";
import { clock, PROVIDER_NAMES } from "./format";

/** Shared when the app sees nothing being watched (desktop, or no YouTube tab): a fake video. */
const MOCK_CONTENT: RoomContent = { provider: "mock", contentId: "mock-1", title: "Mock 영상", durationMs: 10 * 60_000 };

type Props = { me: Me; onMeChange: (me: Me) => void; onSignedOut: () => void };

export function Home({ me, onMeChange, onSignedOut }: Props) {
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [blocked, setBlocked] = useState<UserSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [openRoom, setOpenRoom] = useState<string | null>(null);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [watchRequests, setWatchRequests] = useState<UserSummary[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());
  const watching = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.nowWatching ?? nothing);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const closeRoom = useCallback((note?: string) => {
    setOpenRoom(null);
    setError(note ?? null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [f, r, b, rs] = await Promise.all([api.friends(), api.friendRequests(), api.blocked(), api.rooms()]);
      setFriends(f);
      setRequests(r);
      setBlocked(b);
      setRooms(rs);
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
        platform.connected?.(s === "open" ? socket : null);
        if (s === "open") void reload(); // catch up on anything missed while disconnected
      },
      onEvent: (event) => {
        listeners.current.forEach((l) => l(event));
        if (event.type === "friend:update" || event.type === "room:invite" || event.type === "room:update") {
          void reload();
        }
        if (event.type === "watch:request") {
          const from = event.payload as UserSummary;
          setWatchRequests((list) => [...list.filter((u) => u.id !== from.id), from]);
          notify(`${from.displayName}님이 같이 보자고 합니다`, "눌러서 같이 보기 방을 만들 수 있습니다.");
        }
        if (event.type === "room:invite") {
          const room = event.payload as RoomView;
          const host = room.members.find((m) => m.role === "HOST")?.user.displayName ?? "친구";
          notify(`${host}님의 같이 보기 초대`, room.content.title);
        }
        if (event.type === "presence:update" && event.userId) {
          const presence = event.payload as PresenceView;
          setFriends((list) => list.map((f) => (f.user.id === event.userId ? { ...f, presence } : f)));
        }
      },
    });
    setSocket(socket);
    return () => {
      socket.close();
      platform.connected?.(null);
    };
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

  /** Invites into my room for what I watch now, or starts one with it. */
  async function watchTogether(friend: UserSummary) {
    setError(null);
    const hosted = roomToInvite(rooms, me.id, openRoom, watching);
    try {
      if (hosted) await api.inviteToRoom(hosted.id, [friend.id]);
      setOpenRoom(hosted?.id ?? (await api.createRoom(watching ?? MOCK_CONTENT, [friend.id])).id);
      setWatchRequests((list) => list.filter((u) => u.id !== friend.id)); // answered; kept on failure to retry
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "방을 만들지 못했습니다.");
    }
  }

  async function requestWatch(friend: UserSummary) {
    setError(null);
    setNotice(null);
    try {
      await api.requestWatch(friend.id);
      setNotice(`${friend.displayName}님에게 같이 보자고 요청했습니다. 초대가 오면 알려드립니다.`);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(status === 409 ? "친구가 오프라인입니다." : status === 429 ? "방금 요청했습니다. 잠시 후 다시 시도하세요." : "요청하지 못했습니다.");
    }
  }

  const requestBanner = watchRequests.length > 0 && (
    <div className="container banner">
      {watchRequests.map((u) => (
        <div key={u.id} className="row">
          <span className="grow">{u.displayName}님이 같이 보자고 합니다</span>
          <button onClick={() => void watchTogether(u)}>같이 보기</button>
          <button className="link" onClick={() => setWatchRequests((list) => list.filter((x) => x.id !== u.id))}>무시</button>
        </div>
      ))}
    </div>
  );

  if (openRoom && socket) {
    return (
      <>
        {requestBanner}
        {error && <div className="container"><p className="error" role="alert">{error}</p></div>}
        {/* keyed: another room starts from fresh state (versions, clock, player) */}
        <Room key={openRoom} roomId={openRoom} me={me} socket={socket} status={status} subscribe={subscribe} onClose={closeRoom} />
      </>
    );
  }

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
      {requestBanner}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
      <p className="muted">
        {watching ? `지금 보는 영상: ${watching.title} · "같이 보기"로 공유` : `"같이 보기"는 Mock 영상으로 방을 만듭니다`}
      </p>

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
              {f.presence.status === "WATCHING" && (
                <button onClick={() => void requestWatch(f.user)} title="친구가 보는 영상으로 같이 보자고 요청합니다">합류 요청</button>
              )}
              <button onClick={() => void watchTogether(f.user)} title="내 방에 초대합니다">같이 보기</button>
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

      {rooms.length > 0 && (
        <section>
          <h2>방</h2>
          <ul className="list">
            {rooms.map((r) => {
              const host = r.members.find((m) => m.role === "HOST");
              const mine = host?.user.id === me.id;
              return (
                <li key={r.id} className="friend">
                  <div className="grow">
                    <strong>{r.content.title}</strong>
                    <div className="muted">
                      {mine ? "내가 만든 방" : `${host?.user.displayName}님의 초대`} · {r.members.filter((m) => m.present).length}명 참가 중
                    </div>
                  </div>
                  <button onClick={() => setOpenRoom(r.id)}>입장</button>
                  <button className="link danger" onClick={act(() => api.leaveRoom(r.id))}>
                    {mine ? "닫기" : "나가기"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <MyFriendCode me={me} onMeChange={onMeChange} />
      <AddFriend onSent={reload} />
      <Privacy me={me} onChange={onMeChange} />
      <ExperimentalSettings />

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

/**
 * The room I host to invite a friend into: the one showing what I watch now (the open one first). When I
 * watch nothing the app can see (desktop), any room I host. undefined = start a new room.
 */
export function roomToInvite(rooms: RoomView[], meId: string, openRoom: string | null, watching: RoomContent | null) {
  return [...rooms]
    .sort((a, b) => Number(b.id === openRoom) - Number(a.id === openRoom))
    .find(
      (r) =>
        r.members.some((m) => m.user.id === meId && m.role === "HOST") &&
        (!watching || (r.content.provider === watching.provider && r.content.contentId === watching.contentId)),
    );
}

/** Only when the user isn't looking at the app: otherwise the screen already shows it. */
function notify(title: string, body: string) {
  if (!document.hasFocus()) platform.notify?.(title, body);
}

const noSubscribe = () => () => {};
const nothing = () => null;

function formatCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}


function describe(p: PresenceView) {
  if (p.status === "OFFLINE") return "오프라인";
  if (!p.media) return "온라인";
  const m = p.media;
  const title = m.episodeTitle ? `${m.title} · ${m.episodeTitle}` : m.title;
  const position = m.positionMs !== undefined ? ` · ${clock(m.positionMs)}` : "";
  return `${PROVIDER_NAMES[m.provider]} · ${title} ${m.playing ? "시청 중" : "일시정지"}${position}`;
}

function rank(p: PresenceView) {
  return p.status === "WATCHING" ? 0 : p.status === "ONLINE" ? 1 : 2;
}
