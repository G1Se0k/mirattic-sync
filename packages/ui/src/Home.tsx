import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ApiError, connectSocket, type Socket, type SocketStatus } from "@mirattic/client";
import type {
  MediaProvider,
  ChatDeleted,
  ChatMessage,
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
import { ReportDialog } from "./Report";
import { Room } from "./Room";
import { MyFriendCode, Settings } from "./Settings";
import { localRoom } from "./localRoom";
import { without } from "./Chat";
import { clock, latest, PROVIDER_NAMES } from "./format";
import { Avatar, IconButton } from "./Icons";
import { ExperimentControl, isExperiment, useExperiment } from "./Experimental";

type Props = { me: Me; onMeChange: (me: Me) => void; onSignedOut: () => void };

export function Home({ me, onMeChange, onSignedOut }: Props) {
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [blocked, setBlocked] = useState<UserSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  // The extension may still be in a room from before the panel was closed: back into it.
  const [openRoom, setOpenRoom] = useState<string | null>(() => platform.activeRoom?.() ?? null);
  const [screen, setScreen] = useState<"home" | "settings">("home");
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [joining, setJoining] = useState(false);
  /** A site opened by "방 생성" with nothing watched: the room is made once a video of it plays. */
  const [pending, setPending] = useState<MediaProvider | null>(null);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [watchRequests, setWatchRequests] = useState<UserSummary[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [reporting, setReporting] = useState<UserSummary | null>(null);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());
  const watching = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.nowWatching ?? nothing);
  const activeRoom = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.activeRoom ?? nothing);
  // Read by the socket handler, which outlives renders.
  const current = useRef({ rooms, openRoom });
  current.current = { rooms, openRoom };
  // Room lists answer in any order; one started before a count changed locally must not overwrite it.
  const roomsLoad = useRef(latest()).current;
  const refetchRooms = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Messages of rooms not in the list yet (an invite racing its first message): notified once listed. */
  const unlisted = useRef<ChatMessage[]>([]);
  /** Recent deletions: a message whose delivery was overtaken by its deletion is neither counted nor notified. */
  const deletedChats = useRef<ChatDeleted[]>([]);

  /** A local change to the list, visible to the socket handler at once; loads started before it are dropped. */
  const updateRooms = useCallback((change: (list: RoomView[]) => RoomView[]) => {
    roomsLoad.invalidate();
    current.current.rooms = change(current.current.rooms);
    setRooms(change);
  }, [roomsLoad]);

  const notifyChat = useCallback((room: RoomView, m: ChatMessage) => {
    const from = room.members.find((x) => x.user.id === m.userId)?.user.displayName ?? "친구";
    if (!room.muted) notify(`${from} · ${room.content.title}`, m.text);
  }, []);

  /** The server's list (its unread counts include the unlisted messages). */
  const applyRooms = useCallback((rs: RoomView[]) => {
    current.current.rooms = rs;
    setRooms(rs);
    const { listed, waiting } = settleUnlisted(unlisted.current, rs, current.current.openRoom);
    unlisted.current = waiting;
    listed.forEach(([room, m]) => notifyChat(room, m));
  }, [notifyChat]);

  /** The server's counts, once a burst of chat events settles. */
  const settleRooms = useCallback(() => {
    clearTimeout(refetchRooms.current);
    refetchRooms.current = setTimeout(async () => {
      const fresh = roomsLoad.begin();
      const rs = await api.rooms().catch(() => null);
      if (rs && fresh()) applyRooms(rs);
    }, ROOMS_REFETCH_MS);
  }, [roomsLoad, applyRooms]);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const closeRoom = useCallback(() => {
    setOpenRoom(null);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const fresh = roomsLoad.begin();
      const [f, r, b, rs] = await Promise.all([api.friends(), api.friendRequests(), api.blocked(), api.rooms()]);
      setFriends(f);
      setRequests(r);
      setBlocked(b);
      if (fresh()) applyRooms(rs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    }
  }, [onSignedOut, applyRooms]);

  useEffect(() => {
    const handlers = {
      onStatus: (s: SocketStatus) => {
        setStatus(s);
        platform.connected?.(s === "open" ? socket : null);
        if (s === "open") void reload(); // catch up on anything missed while disconnected
      },
      onEvent: (event: ServerEvent) => {
        listeners.current.forEach((l) => l(event));
        if (event.type === "room:update" && typeof (event.payload as { muted?: unknown } | null)?.muted === "boolean") {
          // Muted from another app of mine: applied now, so no message notifies by the old setting meanwhile.
          const muted = (event.payload as { muted: boolean }).muted;
          updateRooms((list) => list.map((r) => (r.id === event.roomId ? { ...r, muted } : r)));
        }
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
        if (event.type === "chat:message" && without([event.payload as ChatMessage], deletedChats.current).length) {
          const m = event.payload as ChatMessage;
          // The open room shows it; reactions and my own messages are never unread.
          if (m.roomId !== current.current.openRoom && m.userId !== me.id && !m.reaction) {
            const room = current.current.rooms.find((r) => r.id === m.roomId);
            // Known room: count and notify now. A room not listed yet (just invited): once the refetch lists it.
            if (room) {
              updateRooms((list) => list.map((r) => (r.id === m.roomId ? { ...r, unread: r.unread + 1 } : r)));
              notifyChat(room, m);
            } else unlisted.current.push(m);
            settleRooms();
          }
        }
        // A deleted message may have been unread (the server's count) or still waiting to be notified.
        if (event.type === "chat:delete") {
          const d = event.payload as ChatDeleted;
          deletedChats.current = [...deletedChats.current, d].slice(-MAX_DELETED);
          unlisted.current = without(unlisted.current, [d]);
          settleRooms();
        }
        if (event.type === "presence:update" && event.userId) {
          const presence = event.payload as PresenceView;
          setFriends((list) => list.map((f) => (f.user.id === event.userId ? { ...f, presence } : f)));
        }
      },
    };
    // The extension's background owns the socket (it outlives the side panel); otherwise the screen opens one.
    const socket: Socket = platform.connect?.(handlers)
      ?? connectSocket({ url: SOCKET_URL, getTicket: api.wsTicket, ...handlers });
    setSocket(socket);
    return () => {
      clearTimeout(refetchRooms.current);
      socket.close();
      platform.connected?.(null);
    };
  }, [reload, me.id, updateRooms, notifyChat, settleRooms]);

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

  /** Leaving (or closing, as the host) from the list; the extension stops syncing it if it is the active one. */
  async function leaveRoom(id: string) {
    if (!confirm(rooms.find((r) => r.id === id)?.members.some((m) => m.user.id === me.id && m.role === "HOST")
      ? "방을 닫을까요? 모든 멤버가 나가게 됩니다." : "방에서 나갈까요?")) return;
    await act(() => api.leaveRoom(id))();
  }

  /** Opening a room reads its chat (the server marks it on `room:join`). */
  function enter(id: string) {
    updateRooms((list) => list.map((r) => (r.id === id ? { ...r, unread: 0 } : r)));
    setOpenRoom(id);
  }

  const sorted = [...friends].sort((a, b) => rank(a.presence) - rank(b.presence));

  /** Invites into my room for what I watch now, or starts one with it. */
  async function watchTogether(friend: UserSummary) {
    setError(null);
    const hosted = roomToInvite(rooms, me.id, openRoom, watching);
    if (!hosted && !watching) return setError("같이 볼 영상을 먼저 여세요 (YouTube · Netflix · Laftel).");
    try {
      if (hosted) await api.inviteToRoom(hosted.id, [friend.id]);
      setOpenRoom(hosted?.id ?? (await api.createRoom(watching!, [friend.id])).id);
      setWatchRequests((list) => list.filter((u) => u.id !== friend.id)); // answered; kept on failure to retry
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "방을 만들지 못했습니다.");
    }
  }

  /** "방 생성": with what I watch now, else pick a site and the room comes when a video of it is open. */
  async function createRoom() {
    if (creating.current) return;
    setError(null);
    // Only the extension sees what plays in a tab; the desktop app can't wait for a video to be opened.
    if (!watching) return platform.nowWatching ? setChoosing(true) : setError("지금 보는 영상이 없습니다. 영상을 연 뒤 다시 시도하세요.");
    await makeRoom(watching);
  }
  /** One creation at a time; its answer opens the room only if I haven't entered another meanwhile. */
  const creating = useRef(false);
  async function makeRoom(content: NonNullable<typeof watching>) {
    creating.current = true;
    try {
      const room = await api.createRoom(content, []);
      if (!current.current.openRoom) setOpenRoom(room.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "방을 만들지 못했습니다.");
    } finally {
      creating.current = false;
    }
  }
  // Entering any room drops the wait: it must not later make a room and pull me out of this one.
  useEffect(() => {
    if (openRoom) setPending(null);
  }, [openRoom]);
  useEffect(() => {
    if (!pending || openRoom || watching?.provider !== pending || creating.current) return;
    setPending(null);
    void makeRoom(watching);
  }, [pending, watching, openRoom]);

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

  // The room screen's live side: the extension's background runs it (and keeps it when the panel closes);
  // otherwise it runs here and leaves with the screen.
  const local = useRef<ReturnType<typeof localRoom> | null>(null);
  const handle = useMemo(() => {
    if (!openRoom || !socket) return null;
    if (platform.room) return platform.room(openRoom);
    return (local.current = localRoom(openRoom, me.id, socket, subscribe));
  }, [openRoom, socket, me.id, subscribe]);
  useEffect(() => {
    if (!handle) return;
    handle.show();
    return () => handle.close();
  }, [handle]);
  useEffect(() => local.current?.setConnected(status === "open"), [handle, status]);

  const requestBanner = watchRequests.map((u) => (
    <div key={u.id} className="banner">
      <Avatar name={u.displayName} />
      <span className="grow">{u.displayName}님이 같이 보자고 합니다</span>
      <button onClick={() => void watchTogether(u)}>같이 보기</button>
      <IconButton icon="close" label="무시" onClick={() => setWatchRequests((list) => list.filter((x) => x.id !== u.id))} />
    </div>
  ));

  if (openRoom && socket && handle) {
    return (
      <div className="room-page">
        {requestBanner}
        {error && <div className="banner"><p className="error grow" role="alert">{error}</p></div>}
        {/* keyed: another room starts from fresh state (versions, clock, player) */}
        <Room key={openRoom} roomId={openRoom} me={me} handle={handle} socket={socket} status={status} subscribe={subscribe}
          onClose={closeRoom}
          onMuted={(muted) => {
            // A list read before the change would bring the old setting back: updateRooms drops it.
            updateRooms((list) => list.map((r) => (r.id === openRoom ? { ...r, muted } : r)));
          }} />
      </div>
    );
  }

  if (screen === "settings") {
    return (
      <Settings me={me} blocked={blocked} onMeChange={onMeChange} onUnblock={(id) => void act(() => api.unblock(id))()}
        onSignedOut={onSignedOut} onClose={() => setScreen("home")} />
    );
  }

  return (
    <>
      <header className="topbar">
        <span className="wordmark grow">Mirattic <span>Sync</span></span>
        <span className={`dot ${status === "open" ? "on" : ""}`} title={status === "open" ? "연결됨" : "연결 중"} />
        <IconButton icon="settings" label="설정" onClick={() => setScreen("settings")} />
      </header>
      {requestBanner}
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="muted">{notice}</p>}
        <div className="card">
          {watching ? (
            <>
              <div className="muted">지금 보는 영상 · {PROVIDER_NAMES[watching.provider]}</div>
              <div className="ellipsis"><strong>{watching.title}</strong></div>
            </>
          ) : (
            <div className="muted">YouTube · Netflix · Laftel 영상을 열면 친구와 같이 볼 수 있습니다.</div>
          )}
        </div>

        {pending && (
          <div className="card row">
            <span className="grow muted">{PROVIDER_NAMES[pending]}에서 영상을 열면 방이 만들어집니다.</span>
            <button className="secondary" onClick={() => setPending(null)}>취소</button>
          </div>
        )}
        <section>
          <div className="row between">
            <h2>방</h2>
            <span className="row">
              <IconButton icon="plus" label="방 생성" onClick={() => void createRoom()} />
              <IconButton icon="hash" label="코드로 입장" onClick={() => setJoining(true)} />
            </span>
          </div>
          {rooms.length === 0 && <p className="muted">아직 방이 없습니다.</p>}
            <ul className="list">
              {rooms.map((r) => {
                const host = r.members.find((m) => m.role === "HOST");
                const mine = host?.user.id === me.id;
                return (
                  <li key={r.id} className={`friend${r.id === activeRoom ? " card active" : ""}`}>
                    <div className="grow">
                      <div className="ellipsis">
                        <span className="name">{r.content.title}</span>
                        {r.unread > 0 && (
                          <span className={`badge ${r.muted ? "quiet" : ""}`} title="읽지 않은 메시지">{r.unread > 99 ? "99+" : r.unread}</span>
                        )}
                      </div>
                      <div className="muted">
                        {r.id === activeRoom ? "참여 중 · " : ""}
                        {mine ? "내가 만든 방" : `${host?.user.displayName}님의 초대`} · {r.members.filter((m) => m.present).length}명
                        {r.muted && " · 알림 꺼짐"}
                      </div>
                    </div>
                    <button onClick={() => enter(r.id)}>입장</button>
                    <IconButton icon="logout" tone="danger" label={mine ? "닫기" : "나가기"} onClick={() => void leaveRoom(r.id)} />
                  </li>
                );
              })}
            </ul>
        </section>
        {choosing && (
          <ChooseSite onPick={(p) => { setChoosing(false); setPending(p); platform.open(SITES[p]); }} onClose={() => setChoosing(false)} />
        )}
        {joining && <JoinByCode onJoined={(id) => { setJoining(false); void reload(); enter(id); }} onClose={() => setJoining(false)} />}

        <section>
          <div className="row between">
            <h2>친구</h2>
            <IconButton icon="userPlus" label="친구 추가" onClick={() => setAdding((a) => !a)} />
          </div>
          {adding && (
            <div className="stack">
              <MyFriendCode me={me} onMeChange={onMeChange} />
              <AddFriend onSent={() => { setAdding(false); void reload(); }} />
            </div>
          )}
          {sorted.length === 0 && !adding && <p className="muted">아직 친구가 없습니다. 오른쪽 위 버튼으로 친구 코드를 입력하세요.</p>}
          <ul className="list">
            {sorted.map((f) => (
              <li key={f.user.id} className="friend">
                <Avatar name={f.user.displayName} on={f.presence.status !== "OFFLINE"} />
                <div className="grow">
                  <div className="name ellipsis">{f.user.displayName}</div>
                  <div className="muted ellipsis">{describe(f.presence)}</div>
                </div>
                <span className="actions">
                  {f.presence.status === "WATCHING" && (
                    <IconButton icon="join" label="합류 요청" onClick={() => void requestWatch(f.user)} />
                  )}
                  <Menu label={`${f.user.displayName} 메뉴`} items={[
                    { label: "친구 삭제", icon: "userMinus", run: act(() => api.removeFriend(f.user.id)) },
                    { label: "신고", icon: "flag", run: () => setReporting(f.user) },
                    { label: "차단", icon: "ban", danger: true, run: act(() => api.block(f.user.id)) },
                  ]} />
                </span>
              </li>
            ))}
          </ul>
          {reporting && (
            <ReportDialog target={{ userId: reporting.id }} user={{ id: reporting.id, name: reporting.displayName }}
              onClose={() => { setReporting(null); void reload(); }} />
          )}
        </section>

        {(requests.incoming.length > 0 || requests.outgoing.length > 0) && (
          <section>
            <h2>친구 요청</h2>
            <ul className="list">
              {requests.incoming.map((r) => (
                <li key={r.id} className="friend">
                  <Avatar name={r.user.displayName} />
                  <span className="grow name">{r.user.displayName}</span>
                  <IconButton icon="check" tone="primary" label="수락" onClick={act(() => api.acceptFriendRequest(r.id))} />
                  <IconButton icon="close" label="거절" onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
              {requests.outgoing.map((r) => (
                <li key={r.id} className="friend">
                  <Avatar name={r.user.displayName} />
                  <span className="grow"><span className="name">{r.user.displayName}</span> <span className="muted">· 대기 중</span></span>
                  <IconButton icon="close" label="취소" onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

type MenuItem = { label: string; icon: Parameters<typeof IconButton>[0]["icon"]; danger?: boolean; run: () => void };

/** A "⋯" button with a small list of less common actions. */
function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="menu">
      <IconButton icon="more" label={label} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} />
      {open && (
        <div className="menu-items" role="menu">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? "danger" : undefined} onClick={() => { setOpen(false); i.run(); }}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const SITES: Record<Exclude<MediaProvider, "mock">, string> = {
  youtube: "https://www.youtube.com/",
  netflix: "https://www.netflix.com/browse",
  laftel: "https://laftel.net/",
};

/** Nothing watched yet: which site to watch on (an experiment is turned on first). */
function ChooseSite({ onPick, onClose }: { onPick: (p: keyof typeof SITES) => void; onClose: () => void }) {
  const [site, setSite] = useState<keyof typeof SITES | null>(null);
  const on = useExperiment(site && isExperiment(site) ? site : undefined);
  const needsTurningOn = !!site && isExperiment(site) && on === false;
  useEffect(() => {
    if (site && !needsTurningOn) onPick(site);
  }, [site, needsTurningOn]);
  return (
    <dialog open className="stack">
      <h2>어디서 볼까요?</h2>
      {needsTurningOn && isExperiment(site) ? (
        <ExperimentControl provider={site} onDone={() => { if (!platform.experimental?.enabled(site)) setSite(null); }} />
      ) : (
        <div className="stack">
          {(Object.keys(SITES) as (keyof typeof SITES)[]).map((p) => (
            <button key={p} className="secondary" onClick={() => setSite(p)}>{PROVIDER_NAMES[p]}</button>
          ))}
        </div>
      )}
      <p className="muted">사이트가 열리면 볼 영상을 고르세요. 영상을 열면 방이 만들어집니다.</p>
      <div className="row"><button className="link" onClick={onClose}>취소</button></div>
    </dialog>
  );
}

function JoinByCode({ onJoined, onClose }: { onJoined: (roomId: string) => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onJoined((await api.joinRoomByCode(code)).id);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 404 ? "그 코드의 방이 없습니다." : status === 409 ? "방이 가득 찼습니다." : status === 429 ? "잠시 후 다시 시도하세요." : "입장하지 못했습니다.");
    }
  }

  return (
    <dialog open className="stack">
      <h2>코드로 입장</h2>
      <form className="row" onSubmit={submit}>
        <input className="grow code" placeholder="방 코드 (예: K7QM-4XPR)" required maxLength={16} autoFocus
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit">입장</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button className="link" onClick={onClose}>취소</button></div>
    </dialog>
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
    <div className="stack">
      <form className="row" onSubmit={submit}>
        <input className="grow code" placeholder="친구 코드 (예: K7QM-4XPR)" required maxLength={16} autoFocus
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit">요청</button>
      </form>
      {note && <p className="muted">{note}</p>}
    </div>
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

const ROOMS_REFETCH_MS = 500;
const MAX_UNLISTED = 20;
const MAX_DELETED = 100;

/**
 * Messages that arrived before their room was listed, against a list from the server: those now listed are
 * due a notification (unless their room is open); the rest keep waiting (a list read before the invite).
 * Capped, so a room never listed (left or closed meanwhile) can't keep messages forever.
 */
export function settleUnlisted(pending: ChatMessage[], rooms: RoomView[], openRoom: string | null) {
  const listed: [RoomView, ChatMessage][] = [];
  const waiting: ChatMessage[] = [];
  for (const m of pending) {
    const room = rooms.find((r) => r.id === m.roomId);
    if (!room) waiting.push(m);
    else if (m.roomId !== openRoom) listed.push([room, m]);
  }
  return { listed, waiting: waiting.slice(-MAX_UNLISTED) };
}

const noSubscribe = () => () => {};
const nothing = () => null;



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
