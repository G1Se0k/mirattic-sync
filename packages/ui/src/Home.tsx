import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import type {
  MediaProvider,
  ChatDeleted,
  ChatMessage,
  FriendRequests,
  FriendView,
  Me,
  PresenceView,
  RoomView,
  ServerEvent,
  UserSummary,
} from "@mirattic/types";
import { episodeLabel, INCOMING_MS, roomToInvite, type IncomingRequest, type WatchingInfo } from "@mirattic/types";
import { api, platform } from "./session";
import { ReportDialog } from "./Report";
import { Room } from "./Room";
import { MyFriendCode, Settings } from "./Settings";
import { without } from "./Chat";
import { clock, latest, PROVIDER_NAMES } from "./format";
import { Avatar, IconButton, ProviderIcon } from "./Icons";
import { ExperimentControl, isExperiment, useExperiment } from "./Experimental";
import { Actions, Dialog, TimeBar, useAsk } from "./Dialog";

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
  const [showCode, setShowCode] = useState(false);
  const asker = useAsk();
  const [choosing, setChoosing] = useState(false);
  const [joining, setJoining] = useState(false);
  /** A site opened by "방 생성" with nothing watched: the room is made once a video of it plays. */
  const [pending, setPending] = useState<MediaProvider | null>(null);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [watchRequests, setWatchRequests] = useState<UserSummary[]>([]);
  /** Rooms inviting me (decision 85): shown as banners until I accept or decline. */
  const [invitations, setInvitations] = useState<RoomView[]>([]);
  const invitationLoads = useRef(0);
  /**
   * When each invitation ("i:" room) and watch request ("r:" friend) stops counting, and each request I sent
   * ("a:" friend), on this device's clock (decision 87: 30 s, the server sends the time left). Past it: not shown.
   */
  const deadlines = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now);
  const expireIn = (key: string, ms = INCOMING_MS) => deadlines.current.set(key, Date.now() + ms);
  const live = (key: string) => (deadlines.current.get(key) ?? 0) > now;
  /** Every change to the watch requests here, numbered: replayed over a list read before it. */
  const requestChanges = useRef<RequestChange[]>([]);
  const requestSeq = useRef(0);
  /** Dismissals the server hasn't confirmed yet: a list read meanwhile may still have them open. */
  const dismissing = useRef(new Set<string>());
  const requestLoads = useRef(0);
  const changeRequest = (user: IncomingRequest, open: boolean) => {
    if (open && user.expiresInMs !== undefined) expireIn(`r:${user.id}`, user.expiresInMs);
    const n = ++requestSeq.current;
    requestChanges.current = [...requestChanges.current, { n, user, open }].slice(-MAX_REQUEST_CHANGES);
    setWatchRequests((list) => applyRequestChanges(list, [{ n: 0, user, open }]));
  };
  /** Friends I asked to watch together: their invite then opens the room by itself. */
  const [asked, setAsked] = useState<string[]>([]);
  /** A request on its way: its cancel waits, or the server wouldn't know the request yet. */
  const [asking, setAsking] = useState<string | null>(null);
  /** Requests I cancelled or that were answered since this panel opened: a late listing mustn't bring them back. */
  const settledAsks = useRef(new Set<string>());
  // A reopened panel: the requests still out, from the server (only the cancel button; entering is the server's
  // `watch:answer`).
  useEffect(() => {
    api.openWatchRequests().then(
      (ids) => {
        ids.forEach((id) => deadlines.current.has(`a:${id}`) || expireIn(`a:${id}`)); // at most 30 s left
        setAsked((list) => [...new Set([...list, ...ids.filter((id) => !settledAsks.current.has(id))])]);
      },
      () => {},
    );
  }, []);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [reporting, setReporting] = useState<UserSummary | null>(null);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());
  const watching = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.nowWatching ?? nothing);
  const info = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.nowWatchingInfo ?? nothing);
  const activeRoom = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.activeRoom ?? nothing);
  // The extension entered another room without this screen (an answer on the alert over the video): show it.
  const lastActive = useRef(activeRoom);
  useEffect(() => {
    if (activeRoom && activeRoom !== lastActive.current) setOpenRoom(activeRoom);
    lastActive.current = activeRoom;
  }, [activeRoom]);
  // Read by the socket handler, which outlives renders.
  const current = useRef({ rooms, openRoom, asked });
  current.current = { rooms, openRoom, asked };
  // Room lists answer in any order; one started before a count changed locally must not overwrite it.
  const roomsLoad = useRef(latest()).current;
  const refetchRooms = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Recent deletions: a message whose delivery was overtaken by its deletion isn't counted. */
  const deletedChats = useRef<ChatDeleted[]>([]);

  /** A local change to the list, visible to the socket handler at once; loads started before it are dropped. */
  const updateRooms = useCallback((change: (list: RoomView[]) => RoomView[]) => {
    roomsLoad.invalidate();
    current.current.rooms = change(current.current.rooms);
    setRooms(change);
  }, [roomsLoad]);

  /** The server's list (its unread counts include messages of rooms not listed here yet). */
  const applyRooms = useCallback((rs: RoomView[]) => {
    current.current.rooms = rs;
    setRooms(rs);
  }, []);

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
      const invites = ++invitationLoads.current;
      const asks = ++requestLoads.current;
      const since = requestSeq.current;
      // Timed lists keep when they arrived: their time left counts from then, not from the slowest request.
      const arrived = <T,>(p: Promise<T>) => p.then((v) => [v, Date.now()] as const);
      const [f, r, b, rs, [inv, invAt], [wr, wrAt]] = await Promise.all([
        api.friends(), api.friendRequests(), api.blocked(), api.rooms(), arrived(api.invitations()),
        arrived(api.incomingWatchRequests().catch(() => null)), // a server without it yet: the live events only
      ]);
      // Only the newest load, and not one started before I answered an invitation: it would bring it back.
      if (invites === invitationLoads.current) {
        inv.forEach((room) => deadlines.current.set(`i:${room.id}`, invAt + (room.expiresInMs ?? INCOMING_MS)));
        setInvitations(inv);
      }
      // Likewise the newest for watch requests, with what came, was cancelled, answered or dismissed meanwhile.
      if (wr && asks === requestLoads.current) {
        // A request that came, went or was answered meanwhile keeps the deadline its event set.
        const changed = new Set(requestChanges.current.filter((c) => c.n > since).map((c) => c.user.id));
        wr.forEach((u) => changed.has(u.id) || deadlines.current.set(`r:${u.id}`, wrAt + (u.expiresInMs ?? INCOMING_MS)));
        const open = wr.filter((u) => !dismissing.current.has(u.id));
        setWatchRequests(applyRequestChanges(open, requestChanges.current.filter((c) => c.n > since)));
      }
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
          const from = event.payload as IncomingRequest;
          expireIn(`r:${from.id}`, from.expiresInMs);
          changeRequest(from, true);
        }
        if (event.type === "watch:cancel") {
          if (event.userId) changeRequest({ id: event.userId, displayName: "" }, false);
        }
        // The friend I asked answered with an invite (the server says so): in at once, no "입장" to press.
        if (event.type === "watch:answer" && event.roomId) {
          void reload(); // a member now: the list has it
          const friendId = event.userId;
          if (friendId) settledAsks.current.add(friendId);
          setAsked((list) => list.filter((id) => id !== friendId));
          setNotice(null);
          setOpenRoom(event.roomId);
        }
        if (event.type === "chat:message" && without([event.payload as ChatMessage], deletedChats.current).length) {
          const m = event.payload as ChatMessage;
          // The open room shows it; my own messages are never unread.
          if (m.roomId !== current.current.openRoom && m.userId !== me.id) {
            const room = current.current.rooms.find((r) => r.id === m.roomId);
            // Known room: counted now. A room not listed yet (just invited): the refetch brings its count.
            if (room) updateRooms((list) => list.map((r) => (r.id === m.roomId ? { ...r, unread: r.unread + 1 } : r)));
            settleRooms();
          }
        }
        // A deleted message may have been unread (the server's count).
        if (event.type === "chat:delete") {
          const d = event.payload as ChatDeleted;
          deletedChats.current = [...deletedChats.current, d].slice(-MAX_DELETED);
          settleRooms();
        }
        if (event.type === "presence:update" && event.userId) {
          const presence = event.payload as PresenceView;
          setFriends((list) => list.map((f) => (f.user.id === event.userId ? { ...f, presence } : f)));
        }
      },
    };
    // The extension's background owns the socket (it outlives the side panel).
    const socket: Socket = platform.connect(handlers);
    setSocket(socket);
    return () => {
      clearTimeout(refetchRooms.current);
      socket.close();
      platform.connected?.(null);
    };
  }, [reload, me.id, updateRooms, settleRooms]);

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
    const hosting = rooms.find((r) => r.id === id)?.members.some((m) => m.user.id === me.id && m.role === "HOST");
    const yes = hosting
      ? await asker.ask("방을 닫을까요?", { body: "모든 멤버가 나가게 됩니다.", ok: "방 닫기", danger: true })
      : await asker.ask("방에서 나갈까요?", { ok: "나가기", danger: true });
    if (!yes) return;
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
      changeRequest(friend, false); // answered; kept on failure to retry
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "방을 만들지 못했습니다.");
    }
  }

  /** "방 생성": with what I watch now, else pick a site and the room comes when a video of it is open. */
  async function createRoom() {
    if (creating.current) return;
    setError(null);
    // Nothing watched: pick a site, and the room comes once a video of it is open.
    if (!watching) return setChoosing(true);
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
  // A video opened while "어디서 볼까요?" is up answers it: the dialog goes.
  useEffect(() => {
    if (watching) setChoosing(false);
  }, [watching]);
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
    // Waiting before the call: the invite may come back before its answer does.
    settledAsks.current.delete(friend.id); // asked again: a listing may show it
    expireIn(`a:${friend.id}`); // counts 30 s: its cancel button goes then
    setAsked((list) => [...list.filter((id) => id !== friend.id), friend.id]);
    setAsking(friend.id);
    try {
      await api.requestWatch(friend.id);
      setNotice(`${friend.displayName}님에게 같이 보자고 요청했습니다. 초대가 오면 바로 입장합니다.`);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status > 0) setAsked((list) => list.filter((id) => id !== friend.id)); // refused (429: asked, then took it back)
      else {
        // No answer (offline, dropped): it may have gone out — the server's list says.
        api.openWatchRequests().then(
          (ids) => setAsked((list) => (ids.includes(friend.id) ? list : list.filter((id) => id !== friend.id))),
          () => {},
        );
      }
      setError(status === 409 ? "친구가 오프라인입니다." : status === 429 ? "방금 요청했습니다. 잠시 후 다시 시도하세요." : "요청하지 못했습니다.");
    } finally {
      setAsking(null);
    }
  }

  async function cancelWatch(friend: UserSummary) {
    setError(null);
    settledAsks.current.add(friend.id);
    setAsked((list) => list.filter((id) => id !== friend.id)); // not waiting any more, even if the call fails
    setNotice(`${friend.displayName}님에게 보낸 합류 요청을 취소했습니다.`);
    try {
      await api.cancelWatchRequest(friend.id);
    } catch {
      setAsked((list) => [...list.filter((id) => id !== friend.id), friend.id]); // still out: cancel again
      setNotice(null);
      setError("요청을 취소하지 못했습니다. 다시 시도하세요.");
    }
  }

  // The room screen's live side: the extension's background runs it (and keeps it when the panel closes).
  const handle = useMemo(() => (openRoom && socket ? platform.room(openRoom) : null), [openRoom, socket]);
  useEffect(() => {
    if (!handle) return;
    handle.show();
    return () => handle.close();
  }, [handle]);

  async function answerInvitation(room: RoomView, accept: boolean) {
    setError(null);
    invitationLoads.current++; // a list read before this answer mustn't bring it back
    setInvitations((list) => list.filter((r) => r.id !== room.id));
    try {
      if (accept) {
        await api.acceptInvitation(room.id);
        setOpenRoom(room.id);
      } else await api.declineInvitation(room.id);
      void reload();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // Still invited unless the server says it's gone: the banner stays for another try.
      if (status !== 404) setInvitations((list) => [room, ...list.filter((r) => r.id !== room.id)]);
      setError(status === 404 ? "초대가 취소되었거나 방이 닫혔습니다." : status === 409 ? "방이 가득 찼습니다."
        : accept ? "입장하지 못했습니다." : "거절하지 못했습니다.");
    }
  }

  /** Gone here at once; the server forgets it so a reopened panel doesn't bring it back. */
  function dismissWatchRequest(friend: UserSummary) {
    changeRequest(friend, false);
    const mine = requestSeq.current;
    const settledSince = () => requestChanges.current.some((c) => c.n > mine && c.user.id === friend.id);
    // A list read before the server closed it may still have it open: filtered out while the call is out...
    dismissing.current.add(friend.id);
    api.dismissWatchRequest(friend.id).then(
      // ...and closed again once it is done, so a load that read before and answers after replays the close.
      () => !settledSince() && changeRequest(friend, false),
      () => {
        // Still open on the server: back, to dismiss again — unless it was settled since (cancelled, asked again).
        if (settledSince()) return;
        changeRequest(friend, true);
        setError("요청을 무시하지 못했습니다. 다시 시도하세요.");
      },
    ).finally(() => dismissing.current.delete(friend.id));
  }

  // Ticks while anything here runs out (the dialogs' seconds, the cancel buttons).
  // Only while one of them is still in time: expired ones stay in the lists but no longer need the clock.
  const counting = invitations.some((r) => live(`i:${r.id}`)) || watchRequests.some((u) => live(`r:${u.id}`))
    || asked.some((id) => live(`a:${id}`));
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);

  // One at a time, like the room's pause request: invitations first, then watch requests; only those in time.
  const invited = invitations.find((r) => live(`i:${r.id}`));
  const invitingHost = invited?.members.find((m) => m.role === "HOST")?.user;
  const requester = !invited ? watchRequests.find((u) => live(`r:${u.id}`)) : undefined;
  const incoming = invited ? (
    <Dialog alert title={`${invitingHost?.displayName ?? "친구"}님이 같이 보기에 초대했습니다`} onClose={() => void answerInvitation(invited, false)}>
      <p>{invited.content.title}</p>
      <Actions>
        <button className="link" onClick={() => void answerInvitation(invited, false)}>거절</button>
        <button onClick={() => void answerInvitation(invited, true)}>입장</button>
      </Actions>
      <TimeBar key={`i:${invited.id}:${deadlines.current.get(`i:${invited.id}`)}`} until={deadlines.current.get(`i:${invited.id}`)!} total={INCOMING_MS} />
    </Dialog>
  ) : requester ? (
    <Dialog alert title={`${requester.displayName}님이 같이 보자고 합니다`} onClose={() => dismissWatchRequest(requester)}>
      <p className="muted">지금 보는 영상으로 초대합니다.</p>
      <Actions>
        <button className="link" onClick={() => dismissWatchRequest(requester)}>무시</button>
        <button onClick={() => void watchTogether(requester)}>같이 보기</button>
      </Actions>
      <TimeBar key={`r:${requester.id}:${deadlines.current.get(`r:${requester.id}`)}`} until={deadlines.current.get(`r:${requester.id}`)!} total={INCOMING_MS} />
    </Dialog>
  ) : null;

  if (openRoom && socket && handle) {
    return (
      <div className="room-page">
        {error && <div className="banner"><p className="error grow" role="alert">{error}</p></div>}
        {/* keyed: another room starts from fresh state (versions, clock, player) */}
        <Room key={openRoom} roomId={openRoom} me={me} handle={handle} socket={socket} status={status} subscribe={subscribe}
          onClose={closeRoom}
          onMuted={(muted) => {
            // A list read before the change would bring the old setting back: updateRooms drops it.
            updateRooms((list) => list.map((r) => (r.id === openRoom ? { ...r, muted } : r)));
          }} />
        {/* After the room: an invitation or watch request shows over its dialogs (same layer, later on top). */}
        {incoming}
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
    <div className="home">
      {asker.dialog}
      <header className="topbar">
        <span className="wordmark grow">Mirattic <span>Sync</span></span>
        <span className={`dot ${status === "open" ? "on" : ""}`} title={status === "open" ? "연결됨" : "연결 중"} />
        <IconButton icon="settings" label="설정" onClick={() => setScreen("settings")} />
      </header>
      {incoming}
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="muted">{notice}</p>}
        <div className="card">
          {watching ? (
            <div className="row">
              <ProviderIcon provider={watching.provider} />
              <div className="grow">
                <div className="muted">지금 보는 영상 · {PROVIDER_NAMES[watching.provider]}</div>
                {/* Like a friend's lines: the channel above (YouTube), the episode below (Netflix, Laftel). */}
                {info?.channel && <div className="muted ellipsis">{info.channel}</div>}
                <div className="ellipsis"><strong>{info?.title ?? watching.title}</strong></div>
                {info && episodeLabel(info) && <div className="muted">{episodeLabel(info)}</div>}
              </div>
            </div>
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
                    <ProviderIcon provider={r.content.provider} />
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
          <ChooseSite onPick={(p) => { setChoosing(false); setPending(p); platform.open(SITES[p], true); }} onClose={() => setChoosing(false)} />
        )}
        {joining && <JoinByCode onJoined={(id) => { setJoining(false); void reload(); enter(id); }} onClose={() => setJoining(false)} />}

        <section>
          <div className="row between">
            <h2>친구</h2>
            <IconButton icon="userPlus" label="친구 추가" onClick={() => setAdding((a) => !a)} />
          </div>
          {adding && (
            <div className="stack">
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
                  {describe(f.presence).map((line, i) => <div key={i} className="muted ellipsis">{line || "\u00a0"}</div>)}
                </div>
                <span className="actions">
                  {asked.includes(f.user.id) && live(`a:${f.user.id}`) ? (
                    <IconButton icon="close" label="합류 요청 취소" disabled={asking === f.user.id} onClick={() => void cancelWatch(f.user)} />
                  ) : f.presence.status === "WATCHING" && (
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
      <footer className="me-bar">
        {showCode && <MyFriendCode me={me} />}
        <div className="friend">
          <Avatar name={me.displayName} on={status === "open"} />
          <div className="grow">
            <div className="name ellipsis">{me.displayName} <span className="muted">(나)</span></div>
            {(info ? describe({ status: "WATCHING", media: info }) : [status === "open" ? "온라인" : "연결 중"]).map((line, i) => (
              <div key={i} className="muted ellipsis">{line || "\u00a0"}</div>
            ))}
            {me.presenceVisibility === "OFF" && <div className="muted">친구에게 숨김</div>}
          </div>
          <IconButton icon="hash" label={showCode ? "친구 코드 닫기" : "내 친구 코드"} onClick={() => setShowCode((v) => !v)} />
        </div>
      </footer>
    </div>
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
  // Once: turning the control on picks the site at once, and the shared state saying so may come before or after.
  const picked = useRef(false);
  const pick = (p: keyof typeof SITES) => {
    if (picked.current) return;
    picked.current = true;
    onPick(p);
  };
  useEffect(() => {
    if (site && !needsTurningOn) pick(site);
  }, [site, needsTurningOn]);
  return (
    <Dialog title="어디서 볼까요?" onClose={onClose}>
      {needsTurningOn && isExperiment(site) ? (
        <ExperimentControl provider={site} onDone={(turnedOn) => (turnedOn ? pick(site) : setSite(null))} />
      ) : (
        <div className="stack">
          {(Object.keys(SITES) as (keyof typeof SITES)[]).map((p) => (
            <button key={p} className="secondary" onClick={() => setSite(p)}>{PROVIDER_NAMES[p]}</button>
          ))}
        </div>
      )}
      <p className="muted">사이트가 열리면 볼 영상을 고르세요. 영상을 열면 방이 만들어집니다.</p>
      <Actions><button className="link" onClick={onClose}>취소</button></Actions>
    </Dialog>
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
    <Dialog title="코드로 입장" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <input className="code" placeholder="방 코드 (예: K7QM-4XPR)" required maxLength={16} autoFocus
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <Actions>
          <button type="button" className="link" onClick={onClose}>취소</button>
          <button type="submit">입장</button>
        </Actions>
      </form>
    </Dialog>
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

export type RequestChange = { n: number; user: UserSummary; open: boolean };
/** Changes kept to replay over a list load in flight. ponytail: more during one load drops the oldest. */
const MAX_REQUEST_CHANGES = 100;

/** The watch requests after these changes, in order: an open one goes last (newest), a closed one goes. */
export function applyRequestChanges(list: UserSummary[], changes: RequestChange[]): UserSummary[] {
  return changes.reduce(
    (acc, c) => [...acc.filter((u) => u.id !== c.user.id), ...(c.open ? [c.user] : [])],
    list,
  );
}

const ROOMS_REFETCH_MS = 500;
const MAX_DELETED = 100;

const noSubscribe = () => () => {};
const nothing = () => null;



/**
 * A friend's status lines: YouTube adds the channel above the title; Netflix and Laftel put the episode ("3화") below it,
 * an empty line when it has none.
 */
export function describe(p: { status: PresenceView["status"]; media?: WatchingInfo & { positionMs?: number; episodeTitle?: string } }): string[] {
  if (p.status === "OFFLINE") return ["오프라인"];
  if (!p.media) return ["온라인"];
  const m = p.media;
  const position = m.positionMs !== undefined ? ` · ${clock(m.positionMs)}` : "";
  const line = (title: string) => `${PROVIDER_NAMES[m.provider]} · ${title}${position}`;
  if (m.provider === "youtube") return [m.channel ?? "", line(m.title)];
  if (m.provider === "netflix" || m.provider === "laftel") return [line(m.title), episodeLabel(m)];
  return [line(m.episodeTitle ? `${m.title} · ${m.episodeTitle}` : m.title)];
}

function rank(p: PresenceView) {
  return p.status === "WATCHING" ? 0 : p.status === "ONLINE" ? 1 : 2;
}
