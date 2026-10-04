import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import type {
  FriendRequests,
  FriendView,
  Me,
  PresenceView,
  RoomView,
  ServerEvent,
  UserSummary,
} from "@mirattic/types";
import { episodeLabel, INCOMING_MS, memberLimitOf, roomToInvite, type IncomingRequest, type WatchingInfo } from "@mirattic/types";
import { api, platform } from "./session";
import { ReportDialog } from "./Report";
import { Room } from "./Room";
import { MyFriendCode, Settings } from "./Settings";
import { latest, PROVIDER_NAMES } from "./format";
import { Avatar, IconButton, PanelWindowButton, ProviderIcon } from "./Icons";
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
  const [joining, setJoining] = useState(false);
  /** A site opened by "방 생성" with nothing watched: the room is made once a video of it plays. */
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A join request of mine the friend declined: "요청이 거절되었습니다" with a red bar until `until`. (The waiting
   * line is worked out from `asked` as it renders, so it follows every change to it.)
   */
  const [declined, setDeclined] = useState<{ friendId: string; until: number } | null>(null);
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
  /** Each friend's requests as they arrive, counted: a new one is another request (a list read isn't). */
  const requestArrivals = useRef(new Map<string, number>());
  const changeRequest = (user: IncomingRequest, open: boolean) => {
    if (open && user.expiresInMs !== undefined) expireIn(`r:${user.id}`, user.expiresInMs);
    const n = ++requestSeq.current;
    requestChanges.current = [...requestChanges.current, { n, user, open }].slice(-MAX_REQUEST_CHANGES);
    setWatchRequests((list) => applyRequestChanges(list, [{ n: 0, user, open }]));
  };
  /** Friends I asked to watch together: their invite then opens the room by itself. */
  const [asked, setAsked] = useState<string[]>([]);
  /** A request on its way: its cancel waits, or the server wouldn't know the request yet. */
  const [asking, setAsking] = useState<string[]>([]);
  /**
   * Which request to each friend is mine now (the server's `askedAt`): a `watch:decline` naming another (earlier)
   * one is stale. A decline arriving while that friend's request call is still out waits for its answer.
   */
  const askedAt = useRef(new Map<string, number>());
  const pendingDeclines = useRef(new Map<string, number | undefined>());
  /** Friends whose request call is out, known at once (the events come outside renders). */
  const inFlight = useRef(new Set<string>());
  /** The friend dismissed my request `at` (if named): unless a newer one of mine is out, no longer waiting. */
  const decline = (friendId: string, at: number | undefined) => {
    const mine = askedAt.current.get(friendId);
    if (at !== undefined && mine !== undefined && at !== mine) return; // an earlier request's
    settledAsks.current.add(friendId);
    setAsked((list) => list.filter((id) => id !== friendId));
    const until = Date.now() + DECLINED_SHOWN_MS;
    setDeclined({ friendId, until });
    setTimeout(() => setDeclined((d) => (d?.until === until ? null : d)), DECLINED_SHOWN_MS);
  };
  /** Requests I cancelled or that were answered since this panel opened: a late listing mustn't bring them back. */
  const settledAsks = useRef(new Set<string>());
  // A reopened panel: the requests still out, from the server (only the cancel button; entering is the server's
  // `watch:answer`).
  useEffect(() => {
    // With their time left; a server without it yet: the ids only (then at most 30 s left).
    api.outgoingWatchRequests().catch(() =>
      api.openWatchRequests().then((ids) => ids.map((friendId) => ({ friendId, expiresInMs: undefined as number | undefined, askedAt: undefined as number | undefined }))),
    ).then(
      (outgoing) => {
        const ids = outgoing.map((r) => r.friendId);
        outgoing.forEach((r) => r.askedAt === undefined || askedAt.current.has(r.friendId) || askedAt.current.set(r.friendId, r.askedAt));
        outgoing.forEach((r) => deadlines.current.has(`a:${r.friendId}`) || expireIn(`a:${r.friendId}`, r.expiresInMs));
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
  // Rooms of mine their host closed (decision 90), kept by the platform until a panel showed the notice.
  const ended = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.closedRooms ?? noneClosed)[0];
  // The extension entered another room without this screen (an answer on the alert over the video): show it.
  const lastActive = useRef(activeRoom);
  useEffect(() => {
    if (activeRoom && activeRoom !== lastActive.current) setOpenRoom(activeRoom);
    lastActive.current = activeRoom;
  }, [activeRoom]);
  // Read by the socket handler, which outlives renders.
  const current = useRef({ rooms, openRoom, asked });
  current.current = { rooms, openRoom, asked };
  // Room lists answer in any order: only the latest one started is applied.
  const roomsLoad = useRef(latest()).current;
  const roomsSoon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The server's list. */
  const applyRooms = useCallback((rs: RoomView[]) => {
    current.current.rooms = rs;
    setRooms(rs);
  }, []);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const closeRoom = useCallback(() => {
    setOpenRoom(null);
    setError(null);
  }, []);

  /** Everything the screen lists; `roomsOnly`: just the rooms and invitations (what `room:update` / `room:invite` change). */
  const reload = useCallback(async (roomsOnly = false) => {
    try {
      const fresh = roomsLoad.begin();
      const invites = ++invitationLoads.current;
      const asks = roomsOnly ? 0 : ++requestLoads.current; // a rooms-only load leaves a full one's requests be
      const since = requestSeq.current;
      // Timed lists keep when they arrived: their time left counts from then, not from the slowest request.
      const arrived = <T,>(p: Promise<T>) => p.then((v) => [v, Date.now()] as const);
      const [rs, [inv, invAt], rest] = await Promise.all([
        api.rooms(), arrived(api.invitations()),
        roomsOnly ? null : Promise.all([api.friends(), api.friendRequests(), api.blocked(),
          arrived(api.incomingWatchRequests().catch(() => null))]), // a server without it yet: the live events only
      ]);
      // Only the newest load, and not one started before I answered an invitation: it would bring it back.
      if (invites === invitationLoads.current) {
        // The server's time left; else what the alert over the video counted (a server not sending it yet).
        inv.forEach((room) => deadlines.current.set(`i:${room.id}`, room.expiresInMs !== undefined
          ? invAt + room.expiresInMs : platform.alertUntil?.("invite", room.id) ?? invAt + INCOMING_MS));
        setInvitations(inv);
      }
      if (fresh()) applyRooms(rs);
      if (!rest) return;
      const [f, r, b, [wr, wrAt]] = rest;
      // Likewise the newest for watch requests, with what came, was cancelled, answered or dismissed meanwhile.
      if (wr && asks === requestLoads.current) {
        // A request that came, went or was answered meanwhile keeps the deadline its event set.
        const changed = new Set(requestChanges.current.filter((c) => c.n > since).map((c) => c.user.id));
        wr.forEach((u) => changed.has(u.id) || deadlines.current.set(`r:${u.id}`, u.expiresInMs !== undefined
          ? wrAt + u.expiresInMs : platform.alertUntil?.("request", u.id) ?? wrAt + INCOMING_MS));
        const open = wr.filter((u) => !dismissing.current.has(u.id));
        setWatchRequests(applyRequestChanges(open, requestChanges.current.filter((c) => c.n > since)));
      }
      setFriends(f);
      setRequests(r);
      setBlocked(b);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    }
  }, [onSignedOut, applyRooms]);

  useEffect(() => {
    const handlers = {
      onStatus: (s: SocketStatus) => {
        setStatus(s);
        platform.connected?.(s === "open" ? socket : null);
        if (s === "replaced") setOpenRoom(null); // the room stops here; back in on "여기서 계속" if still in it
        if (s === "open") void reload(); // catch up on anything missed while disconnected
      },
      onEvent: (event: ServerEvent) => {
        listeners.current.forEach((l) => l(event));
        const scope = refetchFor(event.type);
        if (scope === "all") void reload();
        else if (scope === "rooms") {
          // A burst (a hand-over, members coming and going): one look.
          clearTimeout(roomsSoon.current);
          roomsSoon.current = setTimeout(() => void reload(true), ROOMS_REFETCH_MS);
        }
        if (event.type === "watch:request") {
          const from = event.payload as IncomingRequest;
          requestArrivals.current.set(from.id, (requestArrivals.current.get(from.id) ?? 0) + 1);
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
        // The friend I asked dismissed it: no longer waiting, and told so for a moment.
        if (event.type === "watch:decline" && event.userId) {
          const declinedAt = (event.payload as { askedAt?: number } | null)?.askedAt;
          if (inFlight.current.has(event.userId)) pendingDeclines.current.set(event.userId, declinedAt);
          else decline(event.userId, declinedAt);
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
      clearTimeout(roomsSoon.current);
      socket.close();
      platform.connected?.(null);
    };
  }, [reload, me.id]);

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
  async function turnOff() {
    if (await asker.ask("동기화를 끌까요?", {
      body: "서버 연결을 끊어 친구에게 오프라인으로 보이고, 참여 중인 방에서 나갑니다(내가 방장인 방은 닫힙니다). 패널을 다시 열면 켜집니다.",
      ok: "끄기",
      danger: true,
    })) platform.turnOff?.();
  }

  async function leaveRoom(id: string) {
    const hosting = rooms.find((r) => r.id === id)?.members.some((m) => m.user.id === me.id && m.role === "HOST");
    const yes = hosting
      ? await asker.ask("방을 닫을까요?", { body: "모든 멤버가 나가게 됩니다.", ok: "방 닫기", danger: true })
      : await asker.ask("방에서 나갈까요?", { ok: "나가기", danger: true });
    if (!yes) return;
    await act(() => api.leaveRoom(id))();
  }

  function enter(id: string) {
    setOpenRoom(id);
  }

  const sorted = [...friends].sort((a, b) => rank(a.presence) - rank(b.presence));
  /** In a room of mine right now: nothing to ask them to join (the server refuses it too). */
  const together = (friendId: string) =>
    rooms.some((r) => r.members.some((m) => m.user.id === me.id) && r.members.some((m) => m.user.id === friendId && m.present));

  /** Invites into my room for what I watch now, or starts one with it. */
  async function watchTogether(friend: UserSummary) {
    setError(null);
    const hosted = roomToInvite(rooms, me.id, openRoom, watching);
    try {
      if (hosted) await api.inviteToRoom(hosted.id, [friend.id]);
      setOpenRoom(hosted?.id ?? (await api.createRoom(watching, [friend.id])).id); // no video yet: a room without one
      changeRequest(friend, false); // answered; kept on failure to retry
    } catch (e) {
      // The room filled up since the request (its check is a prediction, decision 106): said plainly.
      const full = e instanceof ApiError && (e.message === "room full" || e.message === "too many invites");
      setError(full ? `방이 가득 차서 ${friend.displayName}님을 초대할 수 없습니다 (최대 ${hosted ? memberLimitOf(hosted) : 8}명).`
        : e instanceof ApiError ? e.message : "방을 만들지 못했습니다.");
    }
  }

  /** "방 생성": at once, with what I watch now or no video yet (decision 92: whatever I open next becomes it). */
  async function createRoom() {
    if (creating.current) return;
    setError(null);
    await makeRoom(watching);
  }
  /** One creation at a time; its answer opens the room only if I haven't entered another meanwhile. */
  const creating = useRef(false);
  async function makeRoom(content: typeof watching) {
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

  async function requestWatch(friend: UserSummary) {
    setError(null);
    setNotice(null);
    // Waiting before the call: the invite may come back before its answer does.
    settledAsks.current.delete(friend.id); // asked again: a listing may show it
    expireIn(`a:${friend.id}`); // counts 30 s: its cancel button goes then
    setAsked((list) => [...list.filter((id) => id !== friend.id), friend.id]);
    setAsking((list) => [...list, friend.id]);
    inFlight.current.add(friend.id);
    pendingDeclines.current.delete(friend.id);
    askedAt.current.delete(friend.id);
    try {
      const at = (await api.requestWatch(friend.id))?.askedAt;
      if (at !== undefined) askedAt.current.set(friend.id, at);
      // A decline that came while the call was out: this request's (same askedAt, or unnamed), or an earlier one's.
      if (pendingDeclines.current.has(friend.id)) decline(friend.id, pendingDeclines.current.get(friend.id));
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
      setError(status === 409 && e instanceof ApiError && e.message === "already in the same room" ? "이미 같은 방에 있습니다."
        : status === 409 && e instanceof ApiError && e.message === "room full" ? `${friend.displayName}님이 있는 방이 가득 찼습니다.`
        : status === 409 ? "친구가 오프라인입니다." : status === 429 ? "방금 요청했습니다. 잠시 후 다시 시도하세요." : "요청하지 못했습니다.");
    } finally {
      inFlight.current.delete(friend.id);
      pendingDeclines.current.delete(friend.id);
      setAsking((list) => list.filter((id) => id !== friend.id));
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

  // My join request (or its decline), at the top of the list or the room.
  // First a decline (for its moment), else a request of mine still in time and already sent.
  const waitingFor = asked.find((id) => !asking.includes(id) && live(`a:${id}`));
  const nameOf = (id: string) => friends.find((f) => f.user.id === id)?.user.displayName ?? "친구";
  const askLine = declined && declined.until > now ? (
    <div className="ask-status card" role="status">
      <p className="error">요청이 거절되었습니다.</p>
      <TimeBar key={`d:${declined.friendId}:${declined.until}`} until={declined.until} total={DECLINED_SHOWN_MS} inline danger />
    </div>
  ) : waitingFor ? (
    <div className="ask-status card" role="status">
      <p className="muted">{nameOf(waitingFor)}님에게 같이 보자고 요청했습니다. 초대가 오면 바로 입장합니다.</p>
      <TimeBar key={`a:${waitingFor}:${deadlines.current.get(`a:${waitingFor}`)}`} until={deadlines.current.get(`a:${waitingFor}`)!}
        total={INCOMING_MS} inline />
    </div>
  ) : null;

  // One at a time, like the room's pause request: invitations first, then watch requests; only those in time.
  const invited = invitations.find((r) => live(`i:${r.id}`));
  const invitingHost = invited?.members.find((m) => m.role === "HOST")?.user;
  const requester = !invited ? watchRequests.find((u) => live(`r:${u.id}`)) : undefined;
  // A watch request shown while I watched something: dismissed ("무시") once I've been without a video for a moment,
  // like its toast over a page — "같이 보기" invites to what I watch. Not one that came while nothing was open.
  // Each request by its friend and its arrival (a new one from the same friend is another; a list read is the same).
  // Forgotten once that request isn't the one shown (answered, run out, another shown).
  // Only while its dialog is on screen: not behind the "replaced" notice or Settings (which don't draw it).
  const roomShown = Boolean(openRoom && socket && handle);
  const dialogOnScreen = status !== "replaced" && (roomShown || screen !== "settings");
  const shownRequest = requester && dialogOnScreen ? `${requester.id}:${requestArrivals.current.get(requester.id) ?? 0}` : null;
  const sawVideo = useRef<string | null>(null);
  useEffect(() => {
    if (shownRequest !== sawVideo.current) sawVideo.current = null;
    if (!requester || !shownRequest) return;
    if (watching) return void (sawVideo.current = shownRequest);
    if (sawVideo.current !== shownRequest) return;
    const t = setTimeout(() => dismissWatchRequest(requester), VIDEO_FREE_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [shownRequest, watching]); // the request itself: the same one while its key is

  const endedNotice = ended ? (
    <Dialog alert title="방이 종료되었습니다" onClose={() => platform.seenClosed?.(ended.roomId)}>
      <p className="muted">방장이 방을 나가 방이 종료되었습니다.</p>
      {ended.title && <p>{ended.title}</p>}
      <Actions><button onClick={() => platform.seenClosed?.(ended.roomId)}>확인</button></Actions>
    </Dialog>
  ) : null;

  // The host changed the room's type (decision 93): confirm, or leave the room — told wherever the panel is.
  const typeNotice = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.roomTypeNotice?.() ?? null);
  const [typeAlways, setTypeAlways] = useState(false);
  useEffect(() => setTypeAlways(false), [typeNotice?.roomId, typeNotice?.version]); // each question starts unchecked
  const typeChanged = typeNotice ? (
    <Dialog alert title={`방장이 방을 ${PROVIDER_NAMES[typeNotice.type]} 방으로 바꿨습니다`}>
      {/* No dismissal: one of the two answers (Escape or a click outside don't count). */}
      <p className="muted">이제 {PROVIDER_NAMES[typeNotice.type]}에서 같이 봅니다. 확인하면 지금 탭이 {PROVIDER_NAMES[typeNotice.type]}(으)로 이동합니다.</p>
      <label className="row check">
        <input type="checkbox" checked={typeAlways} onChange={(e) => setTypeAlways(e.target.checked)} />
        <span>이 방에서는 항상 허용하기 (다음부터 묻지 않고 이동)</span>
      </label>
      <Actions>
        <button className="link danger" onClick={() => platform.answerRoomType?.(typeNotice.roomId, typeNotice.version, true)}>방 나가기</button>
        <button onClick={() => platform.answerRoomType?.(typeNotice.roomId, typeNotice.version, false, typeAlways)}>확인</button>
      </Actions>
    </Dialog>
  ) : null;

  const incoming = invited ? (
    <Dialog alert title={`${invitingHost?.displayName ?? "친구"}님이 같이 보기에 초대했습니다`} onClose={() => void answerInvitation(invited, false)}>
      <p>{invited.content?.title ?? "아직 고른 영상이 없습니다"}</p>
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

  // Another device of the account connected (decision 89): nothing here works until this one takes over again.
  if (status === "replaced") {
    return (
      <div className="home">
        <Dialog alert title="다른 기기에서 사용 중입니다">
          <p className="muted">한 번에 한 기기에서만 쓸 수 있어, 다른 기기에서 접속해 이 기기의 연결이 끊겼습니다. 여기서 계속하면 다른 기기의 연결이 끊깁니다.</p>
          <Actions>
            <button className="link" onClick={onSignedOut}>로그아웃</button>
            <button onClick={() => socket?.resume()}>여기서 계속</button>
          </Actions>
        </Dialog>
      </div>
    );
  }

  if (openRoom && socket && handle) {
    return (
      <div className="room-page">
        {error && <div className="banner"><p className="error grow" role="alert">{error}</p></div>}
        {askLine && <div className="ask-wrap">{askLine}</div>}
        {/* keyed: another room starts from fresh state (versions, clock, player) */}
        <Room key={openRoom} roomId={openRoom} me={me} handle={handle} socket={socket} status={status} subscribe={subscribe}
          onClose={closeRoom} onInvited={() => void reload()} />
        {/* After the room: an invitation or watch request shows over its dialogs (same layer, later on top). */}
        {incoming}
        {endedNotice}
        {typeChanged}
      </div>
    );
  }

  if (screen === "settings") {
    return (
      <>
        <Settings me={me} blocked={blocked} onMeChange={onMeChange} onUnblock={(id) => void act(() => api.unblock(id))()}
          onSignedOut={onSignedOut} onClose={() => setScreen("home")} />
        {endedNotice /* a closure is told wherever the panel is */}
        {typeChanged}
      </>
    );
  }

  return (
    <div className="home">
      {asker.dialog}
      <header className="topbar">
        <span className="wordmark grow">Mirattic <span>Sync</span></span>
        <span className={`dot ${status === "open" ? "on" : ""}`} title={status === "open" ? "연결됨" : "연결 중"} />
        <PanelWindowButton />
        {platform.turnOff && <IconButton icon="power" label="동기화 끄기" onClick={() => void turnOff()} />}
        <IconButton icon="settings" label="설정" onClick={() => setScreen("settings")} />
      </header>
      {incoming}
      {endedNotice}
      {typeChanged}
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}
        {askLine}
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

        {(requests.incoming.length > 0 || requests.outgoing.length > 0) && (
          <section className="group">
            <div className="group-head"><h2>친구 요청 <span className="count">{requests.incoming.length + requests.outgoing.length}</span></h2></div>
            <ul className="list box">
              {requests.incoming.map((r) => (
                <li key={r.id} className="item">
                  <Avatar name={r.user.displayName} />
                  <div className="grow">
                    <div className="name ellipsis">{r.user.displayName}</div>
                    <div className="muted">친구 요청을 보냈습니다</div>
                  </div>
                  <button className="small" onClick={act(() => api.acceptFriendRequest(r.id))}>수락</button>
                  <IconButton icon="close" label="거절" onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
              {requests.outgoing.map((r) => (
                <li key={r.id} className="item">
                  <Avatar name={r.user.displayName} />
                  <div className="grow">
                    <div className="name ellipsis">{r.user.displayName}</div>
                    <div className="muted">요청 보냄 · 대기 중</div>
                  </div>
                  <IconButton icon="close" label="요청 취소" onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="group">
          <div className="group-head">
            <h2>방 {rooms.length > 0 && <span className="count">{rooms.length}</span>}</h2>
            <IconButton icon="plus" label="방 생성" onClick={() => void createRoom()} />
            <IconButton icon="hash" label="코드로 입장" onClick={() => setJoining(true)} />
          </div>
          {rooms.length === 0 ? (
            <div className="box empty">
              <p className="muted">아직 방이 없습니다. 영상을 열고 방을 만들거나, 받은 코드로 들어가세요.</p>
              <span className="row">
                <button className="small" onClick={() => void createRoom()}>방 만들기</button>
                <button className="secondary small" onClick={() => setJoining(true)}>코드로 입장</button>
              </span>
            </div>
          ) : (
            <ul className="list box">
              {rooms.map((r) => {
                const host = r.members.find((m) => m.role === "HOST");
                const mine = host?.user.id === me.id;
                const here = r.id === activeRoom;
                return (
                  <li key={r.id} className={`item${here ? " active" : ""}`} aria-current={here ? "true" : undefined}>
                    {r.content ? <ProviderIcon provider={r.content.provider} /> : <span className="provider none" title="영상 없음">·</span>}
                    <div className="grow">
                      <div className="name ellipsis">{r.content?.title ?? "영상 없음"}</div>
                      <div className="muted">
                        {mine ? "내가 만든 방" : `${host?.user.displayName}님의 초대`} · {r.members.length}/{memberLimitOf(r)}명
                      </div>
                    </div>
                    <IconButton icon="login" tone="primary" label="입장" onClick={() => enter(r.id)} />
                    <IconButton icon="logout" tone="danger" label={mine ? "방 닫기" : "방 나가기"} onClick={() => void leaveRoom(r.id)} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {joining && <JoinByCode onJoined={(id) => { setJoining(false); void reload(); enter(id); }} onClose={() => setJoining(false)} />}

        <section className="group">
          <div className="group-head">
            <h2>친구 {sorted.length > 0 && <span className="count">{sorted.length}</span>}</h2>
            <IconButton icon="userPlus" label="친구 추가" onClick={() => setAdding((a) => !a)} />
          </div>
          {adding && (
            <div className="stack">
              <AddFriend onSent={() => { setAdding(false); void reload(); }} />
            </div>
          )}
          {sorted.length === 0 && !adding && (
            <div className="box empty">
              <p className="muted">아직 친구가 없습니다. 친구의 코드를 입력하거나 내 코드를 알려 주세요.</p>
              <span className="row">
                <button className="small" onClick={() => setAdding(true)}>친구 추가</button>
                <button className="secondary small" onClick={() => setShowCode(true)}>내 친구 코드</button>
              </span>
            </div>
          )}
          {sorted.length > 0 && (
          <ul className="list box">
            {sorted.map((f) => (
              <li key={f.user.id} className="item">
                <Avatar name={f.user.displayName} on={f.presence.status !== "OFFLINE"} />
                <div className="grow">
                  <div className="name ellipsis">{f.user.displayName}</div>
                  {describe(f.presence).map((line, i) => <div key={i} className="muted ellipsis">{line || "\u00a0"}</div>)}
                </div>
                <span className="actions">
                  {asked.includes(f.user.id) && live(`a:${f.user.id}`) ? (
                    <IconButton icon="close" label="합류 요청 취소" disabled={asking.includes(f.user.id)} onClick={() => void cancelWatch(f.user)} />
                  ) : f.presence.status === "WATCHING" && !together(f.user.id) && (
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
          )}
          {reporting && (
            <ReportDialog target={{ userId: reporting.id }} user={{ id: reporting.id, name: reporting.displayName }}
              onClose={() => { setReporting(null); void reload(); }} />
          )}
        </section>
      </main>
      <footer className="me-bar">
        {showCode && <MyFriendCode me={me} />}
        <div className="friend">
          <Avatar name={me.displayName} on={status === "open"} />
          <div className="grow">
            <div className="name ellipsis">{me.displayName} <span className="muted">(나)</span></div>
            {/* What I watch is the card on top; here only how I'm connected. */}
            <div className="muted">{status === "open" ? "온라인" : "연결 중"}</div>
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
/**
 * What a socket event makes the screen read again: rooms and invitations for a room change (`room:update`,
 * `room:invite`); everything for `friend:update` (friends, requests, blocks — a block or an account deletion also
 * sends it). Watch requests come with their own events.
 */
export function refetchFor(type: string): "all" | "rooms" | null {
  if (type === "friend:update") return "all";
  if (type === "room:update" || type === "room:invite") return "rooms";
  return null;
}

export function applyRequestChanges(list: UserSummary[], changes: RequestChange[]): UserSummary[] {
  return changes.reduce(
    (acc, c) => [...acc.filter((u) => u.id !== c.user.id), ...(c.open ? [c.user] : [])],
    list,
  );
}

/** How long "요청이 거절되었습니다" shows. */
const DECLINED_SHOWN_MS = 5_000;
/** Room changes within this are read once. */
const ROOMS_REFETCH_MS = 300;
/** Without a video this long (a page between videos may load meanwhile): a watch request shown is dismissed. */
const VIDEO_FREE_CONFIRM_MS = 3_000;

const noSubscribe = () => () => {};
const nothing = () => null;
const NONE_CLOSED: { roomId: string; title: string }[] = [];
const noneClosed = () => NONE_CLOSED;



/**
 * A friend's (or my own) status lines: YouTube "YouTube · channel" above the title; Netflix and Laftel put the episode ("3화") below it,
 * an empty line when it has none.
 */
export function describe(p: { status: PresenceView["status"]; media?: WatchingInfo & { positionMs?: number; episodeTitle?: string } }): string[] {
  if (p.status === "OFFLINE") return ["오프라인"];
  if (!p.media) return ["온라인"];
  const m = p.media;
  // No playback position anywhere: where they are in it isn't shown.
  const line = (title: string) => `${PROVIDER_NAMES[m.provider]} · ${title}`;
  // YouTube: the site and channel above, the title below.
  if (m.provider === "youtube") return [m.channel ? `${PROVIDER_NAMES.youtube} · ${m.channel}` : PROVIDER_NAMES.youtube, m.title];
  if (m.provider === "netflix" || m.provider === "laftel") return [line(m.title), episodeLabel(m)];
  return [line(m.episodeTitle ? `${m.title} · ${m.episodeTitle}` : m.title)];
}

function rank(p: PresenceView) {
  return p.status === "WATCHING" ? 0 : p.status === "ONLINE" ? 1 : 2;
}
