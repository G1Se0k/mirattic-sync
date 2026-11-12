import { t } from "@mirattic/i18n";
import { useOnLangChange } from "./T";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ApiError, HOST_MUST_SWITCH, type Socket, type SocketStatus } from "@mirattic/client";
import type {
  ChatMessage,
  FriendRequests,
  FriendView,
  Me,
  PresenceView,
  RoomView,
  ServerEvent,
  UserSummary,
} from "@mirattic/types";
import { ALERT_DEFAULTS, contentKey, episodeLabel, mentionAlerts, INCOMING_MS, MAX_MEMBERS, memberLimitOf, roomTitle, roomToInvite, shownContent, type IncomingRequest, type RoomSettings, type WatchingInfo } from "@mirattic/types";
import { api, platform } from "./session";
import { ReportDialog } from "./Report";
import { Room } from "./Room";
import { MyFriendCode, Settings } from "./Settings";
import { usePrivacySave } from "./Privacy";
import { Declined, PublicRoomsDialog, RoomSettingsDialog, type OneRoom } from "./RoomSettings";
import { latest, PROVIDER_NAMES } from "./format";
import { Avatar, Icon, IconButton, PanelWindowButton, ProviderIcon } from "./Icons";
import { Actions, Dialog, TimeBar, useAsk } from "./Dialog";
import logo from "./assets/mirattic.png";

type Props = { me: Me; onMeChange: (me: Me) => void; onSignedOut: () => void };

export function Home({ me, onMeChange, onSignedOut }: Props) {
  const savePrivacy = usePrivacySave();
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [blocked, setBlocked] = useState<UserSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  // The first full load is in (friends): until then an empty list is only not loaded yet (no "아직 없습니다" flashing).
  const [loaded, setLoaded] = useState(false);
  // A room list is in (the one applied, not a load that a newer one made stale): the rooms' empty state and the
  // watching card's action wait for it.
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  // The extension may still be in a room from before the panel was closed: back into it.
  const [openRoom, setOpenRoom] = useState<string | null>(() => platform.activeRoom?.() ?? null);
  const [screen, setScreen] = useState<"home" | "settings">("home");
  const [adding, setAdding] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const asker = useAsk();
  const [joining, setJoining] = useState(false);
  /** The 방 만들기 dialog, with the video it was opened for (decisions 109–110); null: closed. */
  const [newRoom, setNewRoom] = useState<{ content: typeof watching } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  /** A site opened by "방 생성" with nothing watched: the room is made once a video of it plays. */
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  useOnLangChange(() => setError(null));
  const [notice, setNotice] = useState<string | null>(null);
  useOnLangChange(() => setNotice(null));
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
  const current = useRef({ rooms, openRoom, asked, meId: me.id });
  current.current = { rooms, openRoom, asked, meId: me.id };
  /** Mentioned in a room whose screen isn't open (decision 118): a banner on Home until seen or dismissed. */
  const [mentioned, setMentioned] = useState<{ roomId: string; name: string; title?: string; everyone?: boolean } | null>(null);
  // Seen once that room's screen opens, however it was opened (the list, a link, 보기).
  useEffect(() => {
    if (mentioned && openRoom === mentioned.roomId) setMentioned(null);
  }, [mentioned, openRoom]);
  // Room lists answer in any order: only the latest one started is applied.
  const roomsLoad = useRef(latest()).current;
  const roomsSoon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The server's list. */
  const applyRooms = useCallback((rs: RoomView[]) => {
    current.current.rooms = rs;
    setRooms(rs);
    setRoomsLoaded(true);
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
      setLoaded(true);
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
        if (event.type === "chat:message" && event.roomId) {
          const msg = event.payload as ChatMessage;
          const { meId, openRoom: shown, rooms: list } = current.current;
          if (msg.mentions?.includes(meId) && msg.userId !== meId && shown !== event.roomId && banners(msg.mentions.includes("everyone"))) {
            const room = list.find((r) => r.id === event.roomId);
            setMentioned({ roomId: event.roomId, name: msg.userName ?? t("친구"), title: room ? roomTitle(room) : undefined,
              everyone: msg.mentions.includes("everyone") });
          }
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
    // A mention from before Home listened (alerted before the panel opened, or during its start), for this account:
    // taken once its handlers are in, so none falls between (later ones come as events).
    const early = platform.mention?.(me.id);
    if (early?.open) enter(early.roomId); // its toast's 채팅 보기: that room's screen
    else if (early && banners(!!early.everyone)) setMentioned(early);
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
      setError(e instanceof ApiError ? e.message : t("요청에 실패했습니다."));
    }
    await reload();
  };

  /** Leaving (or closing, as the host) from the list; the extension stops syncing it if it is the active one. */
  async function turnOff() {
    if (await asker.ask(t("동기화를 끌까요?"), {
      body: t("서버 연결을 끊어 친구에게 오프라인으로 보이고, 참여 중인 방에서 나갑니다(내가 방장인 방은 닫힙니다). 패널을 다시 열면 켜집니다."),
      ok: t("끄기"),
      danger: true,
    })) platform.turnOff?.();
  }

  async function leaveRoom(id: string) {
    const hosting = rooms.find((r) => r.id === id)?.members.some((m) => m.user.id === me.id && m.role === "HOST");
    const yes = hosting
      ? await asker.ask(t("방을 닫을까요?"), { body: t("모든 멤버가 나가게 됩니다."), ok: t("방 닫기"), danger: true })
      : await asker.ask(t("방에서 나갈까요?"), { ok: t("나가기"), danger: true });
    if (!yes) return;
    await act(() => api.leaveRoom(id))();
  }

  function enter(id: string) {
    setOpenRoom(id);
  }

  /**
   * One room per person (decision 115): a join leaves my other rooms; while I host one, I'm asked first — yes closes it
   * and joins, no throws `Declined` (nothing changed).
   */
  async function oneRoom<T>(join: (close: boolean) => Promise<T>): Promise<T> {
    try {
      return await join(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && e.message === HOST_MUST_SWITCH)) throw e;
      const hosted = rooms.find((r) => r.members.some((m) => m.role === "HOST" && m.user.id === me.id));
      const title = hosted ? roomTitle(hosted) ?? t("새 방") : null;
      const yes = await asker.ask(t("내 방을 닫고 이동할까요?"), {
        body: title ? t("한 번에 한 방에만 있을 수 있습니다. 내가 방장인 '{title}' 방이 닫히고 모든 멤버가 나가게 됩니다.", { title })
          : t("한 번에 한 방에만 있을 수 있습니다. 내가 방장인 방이 닫히고 모든 멤버가 나가게 됩니다."),
        ok: t("방 닫고 이동"), danger: true,
      });
      if (!yes) throw new Declined();
      return join(true);
    }
  }

  // An invitation link's code (decision 113), handed over by the platform: joined as by 코드로 입장, here or in a room.
  // Two accepted close together: only the last one's answer moves the screen.
  const invite = useSyncExternalStore(platform.subscribe ?? noSubscribe, platform.invite ?? nothing);
  const inviteJoins = useRef(0);
  useEffect(() => {
    if (!invite) return;
    platform.inviteTaken?.(invite.id);
    setScreen("home");
    setError(null);
    const join = ++inviteJoins.current;
    oneRoom((close) => api.joinRoomByCode(invite.code, close)).then(
      (r) => { void reload(); if (join === inviteJoins.current) enter(r.id); },
      (err) => { if (join === inviteJoins.current && !(err instanceof Declined)) setError(joinError(err)); });
  }, [invite]); // once per invitation (its object changes only with another)

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
      // No video yet: a room without one.
      setOpenRoom(hosted?.id ?? (await oneRoom((close) => api.createRoom(watching, [friend.id], undefined, close))).id);
      changeRequest(friend, false); // answered; kept on failure to retry
    } catch (e) {
      if (e instanceof Declined) return;
      // The room filled up since the request (its check is a prediction, decision 106): said plainly.
      const full = e instanceof ApiError && (e.message === "room full" || e.message === "too many invites");
      setError(full ? t("방이 가득 차서 {displayName}님을 초대할 수 없습니다 (최대 {v}명).", { displayName: friend.displayName, v: hosted ? memberLimitOf(hosted) : 8 })
        : e instanceof ApiError ? e.message : t("방을 만들지 못했습니다."));
    }
  }

  /** "방 생성": the 방 만들기 dialog first (decision 109), for what I watch now or no video yet (decision 92). */
  // My rooms on what I watch: the one I'm in first (two rooms may show the same video).
  const onThisVideo = watching
    ? rooms.filter((r) => r.content && contentKey(r.content) === contentKey(watching) && r.members.some((m) => m.user.id === me.id))
    : [];
  const watchingRoom = onThisVideo.find((r) => r.id === activeRoom) ?? onThisVideo[0];

  function createRoom() {
    setError(null);
    setNewRoom({ content: watching });
  }
  /** One creation at a time; its answer opens the room only if I haven't entered another meanwhile. A failure stays in
   * the dialog (rejected). */
  const creating = useRef(false);
  async function makeRoom(content: typeof watching, settings: RoomSettings) {
    if (creating.current) return;
    creating.current = true;
    try {
      const room = await oneRoom((close) => api.createRoom(content, [], settings, close));
      setNewRoom(null);
      if (!current.current.openRoom) setOpenRoom(room.id);
    } catch (e) {
      if (!(e instanceof Declined)) throw e; // kept open: nothing made
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
      const answer = await oneRoom((close) => api.requestWatch(friend.id, close));
      if (answer?.roomId) {
        // In their public room at once (decision 111): no request to wait for.
        settledAsks.current.add(friend.id);
        setAsked((list) => list.filter((id) => id !== friend.id));
        void reload();
        enter(answer.roomId);
        return;
      }
      const at = answer?.askedAt;
      if (at !== undefined) askedAt.current.set(friend.id, at);
      // A decline that came while the call was out: this request's (same askedAt, or unnamed), or an earlier one's.
      if (pendingDeclines.current.has(friend.id)) decline(friend.id, pendingDeclines.current.get(friend.id));
    } catch (e) {
      if (e instanceof Declined) return void setAsked((list) => list.filter((id) => id !== friend.id)); // nothing sent
      const status = e instanceof ApiError ? e.status : 0;
      if (status > 0) setAsked((list) => list.filter((id) => id !== friend.id)); // refused (429: asked, then took it back)
      else {
        // No answer (offline, dropped): it may have gone out — the server's list says.
        api.openWatchRequests().then(
          (ids) => setAsked((list) => (ids.includes(friend.id) ? list : list.filter((id) => id !== friend.id))),
          () => {},
        );
      }
      setError(status === 409 && e instanceof ApiError && e.message === "already in the same room" ? t("이미 같은 방에 있습니다.")
        : status === 409 && e instanceof ApiError && e.message === "room full" ? t("{displayName}님이 있는 방이 가득 찼습니다.", { displayName: friend.displayName })
        : status === 409 ? t("친구가 오프라인입니다.") : status === 429 ? t("방금 요청했습니다. 잠시 후 다시 시도하세요.") : t("요청하지 못했습니다."));
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
    setNotice(t("{displayName}님에게 보낸 합류 요청을 취소했습니다.", { displayName: friend.displayName }));
    try {
      await api.cancelWatchRequest(friend.id);
    } catch {
      setAsked((list) => [...list.filter((id) => id !== friend.id), friend.id]); // still out: cancel again
      setNotice(null);
      setError(t("요청을 취소하지 못했습니다. 다시 시도하세요."));
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
        await oneRoom((close) => api.acceptInvitation(room.id, close));
        setOpenRoom(room.id);
      } else await api.declineInvitation(room.id);
      void reload();
    } catch (e) {
      if (e instanceof Declined) return void setInvitations((list) => [room, ...list.filter((r) => r.id !== room.id)]); // still invited
      const status = e instanceof ApiError ? e.status : 0;
      // Still invited unless the server says it's gone: the banner stays for another try.
      if (status !== 404) setInvitations((list) => [room, ...list.filter((r) => r.id !== room.id)]);
      setError(status === 404 ? t("초대가 취소되었거나 방이 닫혔습니다.") : status === 409 ? t("방이 가득 찼습니다.")
        : accept ? t("입장하지 못했습니다.") : t("거절하지 못했습니다."));
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
        setError(t("요청을 무시하지 못했습니다. 다시 시도하세요."));
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
  const nameOf = (id: string) => friends.find((f) => f.user.id === id)?.user.displayName ?? t("친구");
  const askLine = declined && declined.until > now ? (
    <div className="ask-status card" role="status">
      <p className="error">{t("요청이 거절되었습니다.")}</p>
      <TimeBar key={`d:${declined.friendId}:${declined.until}`} until={declined.until} total={DECLINED_SHOWN_MS} inline danger />
    </div>
  ) : waitingFor ? (
    <div className="ask-status card" role="status">
      <p className="muted">{t("{name}님에게 같이 보자고 요청했습니다. 초대가 오면 바로 입장합니다.", { name: nameOf(waitingFor) })}</p>
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
    <Dialog alert title={t("방이 종료되었습니다")} onClose={() => platform.seenClosed?.(ended.roomId)}>
      <p className="muted">{t("방장이 방을 나가 방이 종료되었습니다.")}</p>
      {ended.title && <p>{ended.title}</p>}
      <Actions><button onClick={() => platform.seenClosed?.(ended.roomId)}>{t("확인")}</button></Actions>
    </Dialog>
  ) : null;

  // The host changed the room's type (decision 93): confirm, or leave the room — told wherever the panel is.
  const prefs = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.preferences?.alerts?.() ?? ALERT_DEFAULTS);
  const quiet = prefs.quiet;
  // My status (decisions 120, 121): both kept with the account. 방해 금지 also goes to this device's alert settings
  // (what the background reads to hold toasts back), following the account's whenever it differs.
  const [pendingMode, setPendingMode] = useState<MyStatus | null>(null);
  const myStatus: MyStatus = pendingMode ?? (me.appearOffline ? "hidden" : me.doNotDisturb ? "quiet" : "online");
  // A choice still saving counts already (alerts held back as the menu says), its failure puts the account's back.
  useEffect(() => {
    const dnd = pendingMode ? pendingMode === "quiet" : !!me.doNotDisturb;
    if (dnd !== quiet) void platform.preferences?.setAlerts?.({ quiet: dnd });
  }, [pendingMode, me.doNotDisturb, quiet]);
  const [statusOpen, setStatusOpen] = useState(false);
  const codePop = useRef<HTMLDivElement>(null);
  const codeButton = useRef<HTMLSpanElement>(null);
  // The friend code's popover: closed by a click elsewhere or Escape (back to its button).
  useEffect(() => {
    if (!showCode) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        codeButton.current?.querySelector("button")?.focus();
      } else if (codePop.current?.contains(e.target as Node) || codeButton.current?.contains(e.target as Node)) return;
      setShowCode(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [showCode]);
  /** The last status asked for, while its save is out: only its own answer settles what shows. */
  const wantMode = useRef(0); // the latest choice's number
  const statusMenu = useRef<HTMLUListElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!statusOpen) return;
    statusMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        statusButton.current?.focus();
      } else if (statusMenu.current?.contains(e.target as Node) || statusButton.current?.contains(e.target as Node)) return;
      setStatusOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [statusOpen]);
  function chooseStatus(mode: MyStatus) {
    setStatusOpen(false);
    statusButton.current?.focus();
    if (mode === myStatus) return;
    const mine = ++wantMode.current;
    setPendingMode(mode);
    // One save for both (never on together); in order (usePrivacySave): the last answer holds the last choice.
    savePrivacy({ appearOffline: mode === "hidden", doNotDisturb: mode === "quiet" }).then((saved) => {
      onMeChange(saved);
      if (wantMode.current === mine) setPendingMode(null);
    }, () => {
      if (wantMode.current !== mine) return; // a later choice stands
      setPendingMode(null);
      void asker.tell(t("상태를 바꾸지 못했습니다"), t("이전 상태 그대로입니다. 다시 시도해 주세요."));
    });
  }
  // Turned off while it shows: gone for good (turning them on again doesn't bring it back).
  const bannerAllowed = !mentioned || !prefs.quiet && mentionAlerts(prefs, !!mentioned.everyone);
  useEffect(() => {
    if (!bannerAllowed) setMentioned(null);
  }, [bannerAllowed]);
  const typeNotice = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.roomTypeNotice?.() ?? null);
  const [typeAlways, setTypeAlways] = useState(false);
  useEffect(() => setTypeAlways(false), [typeNotice?.roomId, typeNotice?.version]); // each question starts unchecked
  const typeChanged = typeNotice ? (
    <Dialog alert title={t("방장이 방을 {v} 방으로 바꿨습니다", { v: PROVIDER_NAMES[typeNotice.type] })}>
      {/* No dismissal: one of the two answers (Escape or a click outside don't count). */}
      <p className="muted">{t("이제 {site}에서 같이 봅니다. 확인하면 지금 탭이 {site}(으)로 이동합니다.", { site: PROVIDER_NAMES[typeNotice.type] })}</p>
      <label className="row check">
        <input type="checkbox" checked={typeAlways} onChange={(e) => setTypeAlways(e.target.checked)} />
        <span>{t("이 방에서는 항상 허용하기 (다음부터 묻지 않고 이동)")}</span>
      </label>
      <Actions>
        <button className="link danger" onClick={() => platform.answerRoomType?.(typeNotice.roomId, typeNotice.version, true)}>{t("방 나가기")}</button>
        <button onClick={() => platform.answerRoomType?.(typeNotice.roomId, typeNotice.version, false, typeAlways)}>{t("확인")}</button>
      </Actions>
    </Dialog>
  ) : null;

  const incoming = invited ? (
    <Dialog alert title={t("{v}님이 같이 보기에 초대했습니다", { v: invitingHost?.displayName ?? t("친구") })} onClose={() => void answerInvitation(invited, false)}>
      <p>{roomTitle(invited) ?? (invited.content ? t("영상 없음") : t("아직 고른 영상이 없습니다"))}</p>
      <Actions>
        <button className="link" onClick={() => void answerInvitation(invited, false)}>{t("거절")}</button>
        <button onClick={() => void answerInvitation(invited, true)}>{t("입장")}</button>
      </Actions>
      <TimeBar key={`i:${invited.id}:${deadlines.current.get(`i:${invited.id}`)}`} until={deadlines.current.get(`i:${invited.id}`)!} total={INCOMING_MS} />
    </Dialog>
  ) : requester ? (
    <Dialog alert title={t("{displayName}님이 같이 보자고 합니다", { displayName: requester.displayName })} onClose={() => dismissWatchRequest(requester)}>
      <p className="muted">{t("지금 보는 영상으로 초대합니다.")}</p>
      <Actions>
        <button className="link" onClick={() => dismissWatchRequest(requester)}>{t("무시")}</button>
        <button onClick={() => void watchTogether(requester)}>{t("같이 보기")}</button>
      </Actions>
      <TimeBar key={`r:${requester.id}:${deadlines.current.get(`r:${requester.id}`)}`} until={deadlines.current.get(`r:${requester.id}`)!} total={INCOMING_MS} />
    </Dialog>
  ) : null;

  // Another device of the account connected (decision 89): nothing here works until this one takes over again.
  if (status === "replaced") {
    return (
      <div className="home">
        <Dialog alert title={t("다른 기기에서 사용 중입니다")}>
          <p className="muted">{t("한 번에 한 기기에서만 쓸 수 있어, 다른 기기에서 접속해 이 기기의 연결이 끊겼습니다. 여기서 계속하면 다른 기기의 연결이 끊깁니다.")}</p>
          <Actions>
            <button className="link" onClick={onSignedOut}>{t("로그아웃")}</button>
            <button onClick={() => socket?.resume()}>{t("여기서 계속")}</button>
          </Actions>
        </Dialog>
      </div>
    );
  }

  // On every screen but that room's (decision 118): Home, Settings, another room.
  const mentionBanner = mentioned && mentioned.roomId !== openRoom && bannerAllowed && (
    <div className="card mention-banner" role="status">
      <Icon name="at" />
      <span className="grow">{mentioned.title ? t("{name}님이 '{title}'에서 언급했습니다", { name: mentioned.name, title: mentioned.title })
        : t("{name}님이 언급했습니다", { name: mentioned.name })}</span>
      <button className="small" onClick={() => { setMentioned(null); enter(mentioned.roomId); }}>{t("보기")}</button>
      <IconButton icon="close" label={t("닫기")} onClick={() => setMentioned(null)} />
    </div>
  );

  if (openRoom && socket && handle) {
    return (
      <div className="room-page">
        {error && <div className="banner"><p className="error grow" role="alert">{error}</p></div>}
        {askLine && <div className="ask-wrap">{askLine}</div>}
        {mentionBanner && <div className="ask-wrap">{mentionBanner}</div>}
        {/* keyed: another room starts from fresh state (versions, clock, player) */}
        <Room key={openRoom} roomId={openRoom} me={me} handle={handle} socket={socket} status={status} subscribe={subscribe}
          onClose={closeRoom} onInvited={() => void reload()} />
        {/* After the room: an invitation or watch request shows over its dialogs (same layer, later on top). */}
        {incoming}
        {endedNotice}
        {typeChanged}
        {asker.dialog /* joining another room from here (an invitation, a link): asked over the room */}
      </div>
    );
  }

  if (screen === "settings") {
    return (
      <>
        <Settings me={me} blocked={blocked} onMeChange={onMeChange} savePrivacy={savePrivacy} onUnblock={(id) => void act(() => api.unblock(id))()}
          onSignedOut={onSignedOut} onClose={() => setScreen("home")} banner={mentionBanner} />
        {endedNotice /* a closure is told wherever the panel is */}
        {typeChanged}
        {asker.dialog /* a status that failed to save, told here too */}
      </>
    );
  }

  return (
    <div className="home">
      <header className="topbar">
        <img className="topbar-logo" src={logo} alt="" />
        <span className="wordmark grow">Mirattic <span>Sync</span></span>
        <span className={`dot ${status === "open" ? "on" : ""}`} title={status === "open" ? t("연결됨") : t("연결 중")} />
        <PanelWindowButton />
        {platform.turnOff && <IconButton icon="power" label={t("동기화 끄기")} onClick={() => void turnOff()} />}
        <IconButton icon="settings" label={t("설정")} onClick={() => setScreen("settings")} />
      </header>
      {incoming}
      {endedNotice}
      {typeChanged}
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}
        {askLine}
        {notice && <p className="muted">{notice}</p>}
        {mentionBanner}
        <div className="card">
          {watching ? (
            <div className="row">
              <ProviderIcon provider={watching.provider} />
              <div className="grow">
                <div className="muted">{t("지금 보는 영상 ·")} {PROVIDER_NAMES[watching.provider]}</div>
                {/* Like a friend's lines: the channel above (YouTube), the episode below (Netflix, Laftel). */}
                {info?.channel && <div className="muted ellipsis">{info.channel}</div>}
                <div className="ellipsis"><strong>{info?.title ?? watching.title}</strong></div>
                {info && episodeLabel(info) && <div className="muted">{episodeLabel(info)}</div>}
              </div>
              {/* A room of mine on this video: back into it; else a new one with it (as the rooms' "+"). */}
              {/* Only once the rooms are in: before that a room of mine on it would look missing. */}
              {!roomsLoaded ? null : watchingRoom
                ? <IconButton icon="login" tone="primary" label={t("이 영상의 방으로 돌아가기")} onClick={() => enter(watchingRoom.id)} />
                : <IconButton icon="plus" tone="primary" label={t("이 영상으로 방 만들기")} onClick={createRoom} />}
            </div>
          ) : (
            <div className="muted">{t("YouTube · Netflix · Laftel 영상을 열면 친구와 같이 볼 수 있습니다.")}</div>
          )}
        </div>

        <section className="group">
          <div className="group-head">
            <h2>{t("방")} {rooms.length > 0 && <span className="count">{rooms.length}</span>}</h2>
            <IconButton icon="plus" label={t("방 생성")} onClick={createRoom} />
            <IconButton icon="globe" label={t("공개 방 둘러보기")} onClick={() => setBrowsing(true)} />
            <IconButton icon="hash" label={t("코드로 입장")} onClick={() => setJoining(true)} />
          </div>
          {rooms.length === 0 ? roomsLoaded && (
            // No room yet: the three ways in, as large buttons.
            <div className="tiles">
              <button className="tile primary" onClick={createRoom}><Icon name="plus" size={22} />{t("방 생성")}</button>
              <button className="tile" onClick={() => setBrowsing(true)}><Icon name="globe" size={22} />{t("공개방 탐색")}</button>
              <button className="tile" onClick={() => setJoining(true)}><Icon name="hash" size={22} />{t("코드로 입장")}</button>
            </div>
          ) : (
            <ul className="list box">
              {rooms.map((r) => {
                const host = r.members.find((m) => m.role === "HOST");
                const mine = host?.user.id === me.id;
                const here = r.id === activeRoom;
                return (
                  <li key={r.id} className={`item${here ? " active" : ""}`} aria-current={here ? "true" : undefined}>
                    {shownContent(r) ? <ProviderIcon provider={shownContent(r)!.provider} /> : <span className="provider none" title={t("영상 없음")}>·</span>}
                    <div className="grow">
                      <div className="name ellipsis">{roomTitle(r) ?? t("영상 없음")}</div>
                      <div className="muted">
                        {mine ? t("내가 만든 방") : t("{displayName}님의 방", { displayName: host?.user.displayName ?? "" })} · {r.isPublic ? t("공개") : t("비공개")} · {t("{n}/{max}명", { n: r.members.length, max: memberLimitOf(r) })}
                      </div>
                    </div>
                    <IconButton icon="login" tone="primary" label={t("입장")} onClick={() => enter(r.id)} />
                    <IconButton icon="logout" tone="danger" label={mine ? t("방 닫기") : t("방 나가기")} onClick={() => void leaveRoom(r.id)} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {newRoom && (
          <RoomSettingsDialog title={t("방 만들기")} ok={t("만들기")} initial={{ name: "", memberLimit: MAX_MEMBERS, isPublic: false }}
            placeholder={newRoom.content?.title ?? t("비우면 영상 제목이 보입니다")} onSave={(s) => makeRoom(newRoom.content, s)}
            onClose={() => setNewRoom(null)} />
        )}
        {browsing && (
          <PublicRoomsDialog inRoom={(id) => rooms.some((r) => r.id === id)} oneRoom={oneRoom}
            onJoined={(id) => { setBrowsing(false); void reload(); enter(id); }} onClose={() => setBrowsing(false)} />
        )}
        {joining && <JoinByCode oneRoom={oneRoom} onJoined={(id) => { setJoining(false); void reload(); enter(id); }} onClose={() => setJoining(false)} />}

        <section className="group">
          <div className="group-head">
            <h2>{t("친구")} {sorted.length > 0 && <span className="count">{sorted.length}</span>}</h2>
            <IconButton icon="userPlus" label={t("친구 추가")} onClick={() => setAdding((a) => !a)} />
          </div>
          {adding && (
            <div className="stack">
              <AddFriend onSent={() => { setAdding(false); void reload(); }} />
            </div>
          )}
          {loaded && sorted.length === 0 && !adding && (
            <div className="box empty">
              <p className="muted">{t("아직 친구가 없습니다. 친구의 코드를 입력하거나 내 코드를 알려 주세요.")}</p>
              <span className="row">
                <button className="small" onClick={() => setAdding(true)}>{t("친구 추가")}</button>
                <button className="secondary small" onClick={() => setShowCode(true)}>{t("내 친구 코드")}</button>
              </span>
            </div>
          )}
          {sorted.length > 0 && (
          <ul className="list box">
            {sorted.map((f) => (
              <li key={f.user.id} className="item">
                <Avatar name={f.user.displayName} src={f.user.avatarUrl} on={f.presence.status !== "OFFLINE"}
                  tone={f.presence.doNotDisturb ? "quiet" : undefined} />
                <div className="grow">
                  <div className="name ellipsis">{f.user.displayName}</div>
                  {(f.presence.publicRoom
                    ? [f.presence.doNotDisturb ? t("방해 금지 · 공개방 참여중") : t("공개방 참여중"), f.presence.publicRoom.name ?? t("영상 없음")]
                    : describe(f.presence))
                    .map((line, i) => <div key={i} className="muted ellipsis">{line || "\u00a0"}</div>)}
                </div>
                <span className="actions">
                  {asked.includes(f.user.id) && live(`a:${f.user.id}`) ? (
                    <IconButton icon="close" label={t("합류 요청 취소")} disabled={asking.includes(f.user.id)} onClick={() => void cancelWatch(f.user)} />
                  ) : (f.presence.status === "WATCHING" || f.presence.publicRoom) && !together(f.user.id) && (
                    <IconButton icon="join" label={t("합류 요청")} onClick={() => void requestWatch(f.user)} />
                  )}
                  <Menu label={t("{displayName} 메뉴", { displayName: f.user.displayName })} items={[
                    { label: t("친구 삭제"), icon: "userMinus", run: act(() => api.removeFriend(f.user.id)) },
                    { label: t("신고"), icon: "flag", run: () => setReporting(f.user) },
                    { label: t("차단"), icon: "ban", danger: true, run: act(() => api.block(f.user.id)) },
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

        {(requests.incoming.length > 0 || requests.outgoing.length > 0) && (
          <section className="group">
            <div className="group-head"><h2>{t("친구 요청")} <span className="count">{requests.incoming.length + requests.outgoing.length}</span></h2></div>
            <ul className="list box">
              {requests.incoming.map((r) => (
                <li key={r.id} className="item">
                  <Avatar name={r.user.displayName} src={r.user.avatarUrl} />
                  <div className="grow">
                    <div className="name ellipsis">{r.user.displayName}</div>
                    <div className="muted">{t("친구 요청을 보냈습니다")}</div>
                  </div>
                  <button className="small" onClick={act(() => api.acceptFriendRequest(r.id))}>{t("수락")}</button>
                  <IconButton icon="close" label={t("거절")} onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
              {requests.outgoing.map((r) => (
                <li key={r.id} className="item">
                  <Avatar name={r.user.displayName} src={r.user.avatarUrl} />
                  <div className="grow">
                    <div className="name ellipsis">{r.user.displayName}</div>
                    <div className="muted">{t("요청 보냄 · 대기 중")}</div>
                  </div>
                  <IconButton icon="close" label={t("요청 취소")} onClick={act(() => api.deleteFriendRequest(r.id))} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <footer className="me-bar">
        {showCode && (
          // Over the me bar, as the status menu (not growing it).
          <div className="code-pop" role="dialog" aria-label={t("내 친구 코드")} ref={codePop}>
            <MyFriendCode me={me} />
          </div>
        )}
        {statusOpen && (
          <ul className="menu-items status-menu" role="menu" aria-label={t("내 상태")} ref={statusMenu}>
            {MY_STATUSES().map((s) => (
              <li key={s.mode} role="none">
                <button type="button" role="menuitemradio" aria-checked={myStatus === s.mode} onClick={() => chooseStatus(s.mode)}>
                  <span className={`pip ${s.mode}`} aria-hidden="true" />
                  <span className="text"><strong>{s.label}</strong><span className="muted">{s.about}</span></span>
                  {myStatus === s.mode && <Icon name="check" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="friend">
          {/* What I watch is the card on top; here how I'm connected and my status (decision 120), which this opens. */}
          <button type="button" className="me-status" aria-haspopup="menu" aria-expanded={statusOpen} ref={statusButton}
            onClick={() => setStatusOpen((v) => !v)}>
            <Avatar name={me.displayName} src={me.avatarUrl} on={status === "open"}
              tone={myStatus === "hidden" ? "hidden" : myStatus === "quiet" ? "quiet" : undefined} />
            <span className="grow">
              <span className="name ellipsis">{me.displayName} <span className="muted">{t("(나)")}</span></span>
              <span className="muted">
                {status !== "open" ? t("연결 중") : myStatus === "quiet" ? <span className="quiet">{t("방해 금지")}</span>
                  : myStatus === "hidden" ? <><span className="hidden-status">{t("오프라인으로 표시")}</span> {t("· 친구에게 오프라인")}</> : t("온라인")}
              </span>
              {me.presenceVisibility === "OFF" && <span className="muted">{t("친구에게 숨김")}</span>}
            </span>
          </button>
          <span ref={codeButton} className="code-toggle">
            <IconButton icon="hash" label={showCode ? t("친구 코드 닫기") : t("내 친구 코드")} onClick={() => setShowCode((v) => !v)} />
          </span>
        </div>
      </footer>
      {asker.dialog /* last: over the dialog it asks from (코드로 입장, 공개 방) */}
    </div>
  );
}

type MenuItem = { label: string; icon: Parameters<typeof IconButton>[0]["icon"]; danger?: boolean; run: () => void };

type MyStatus = "online" | "quiet" | "hidden";
/** The me bar's status menu (decision 120). */
const MY_STATUSES = (): { mode: MyStatus; label: string; about: string }[] => [
  { mode: "online", label: t("온라인"), about: t("기본") },
  { mode: "quiet", label: t("방해 금지"), about: t("알림을 띄우지 않음 · 친구에게 방해 금지로 보임") },
  { mode: "hidden", label: t("오프라인으로 표시"), about: t("친구에게 오프라인으로 보임") },
];

/** A mention's banner shows (decision 119): not under 방해 금지, nor with its alerts off. */
function banners(everyone: boolean) {
  const prefs = platform.preferences?.alerts?.() ?? ALERT_DEFAULTS;
  return !prefs.quiet && mentionAlerts(prefs, everyone);
}

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

/** Why joining by a code (typed, or an invitation link's) failed. */
function joinError(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  return status === 404 ? t("그 코드의 방이 없습니다.") : status === 409 ? t("방이 가득 찼습니다.") : status === 429 ? t("잠시 후 다시 시도하세요.") : t("입장하지 못했습니다.");
}

function JoinByCode({ oneRoom, onJoined, onClose }: { oneRoom: OneRoom; onJoined: (roomId: string) => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  useOnLangChange(() => setError(null));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onJoined((await oneRoom((close) => api.joinRoomByCode(code, close))).id);
    } catch (err) {
      if (!(err instanceof Declined)) setError(joinError(err));
    }
  }

  return (
    <Dialog title={t("코드로 입장")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <input className="code" placeholder={t("방 코드 (예: K7QM-4XPR)")} required maxLength={16} autoFocus
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <Actions>
          <button type="button" className="link" onClick={onClose}>{t("취소")}</button>
          <button type="submit">{t("입장")}</button>
        </Actions>
      </form>
    </Dialog>
  );
}

function AddFriend({ onSent }: { onSent: () => void }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  useOnLangChange(() => setNote(null));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const user = await api.sendFriendRequest(code);
      setNote(t("{displayName}님에게 요청을 보냈습니다.", { displayName: user.displayName }));
      setCode("");
      onSent();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setNote(
        status === 404 ? t("해당 코드의 사용자를 찾을 수 없습니다.")
          : status === 409 ? t("이미 친구이거나 요청을 보낸 사용자입니다.")
          : status === 400 ? t("내 코드로는 요청할 수 없습니다.")
          : t("요청에 실패했습니다."),
      );
    }
  }

  return (
    <div className="stack">
      <form className="row" onSubmit={submit}>
        <input className="grow code" placeholder={t("친구 코드 (예: K7QM-4XPR)")} required maxLength={16} autoFocus
          autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit">{t("요청")}</button>
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
export function describe(p: { status: PresenceView["status"]; doNotDisturb?: boolean; media?: WatchingInfo & { positionMs?: number; episodeTitle?: string } }): string[] {
  if (p.status === "OFFLINE") return [t("오프라인")];
  // 방해 금지 (decision 121): said first, before what they watch.
  if (p.doNotDisturb) {
    const [first = "", ...rest] = describe({ ...p, doNotDisturb: false });
    return [p.media ? t("방해 금지 · {first}", { first }) : t("방해 금지"), ...rest];
  }
  if (!p.media) return [t("온라인")];
  const m = p.media;
  // No playback position anywhere: where they are in it isn't shown.
  const line = (title: string) => `${PROVIDER_NAMES[m.provider]} · ${title}`;
  // YouTube: the site and channel above, the title below.
  if (m.provider === "youtube") return [m.channel ? `${PROVIDER_NAMES.youtube} · ${m.channel}` : PROVIDER_NAMES.youtube, m.title];
  if (m.provider === "netflix" || m.provider === "laftel") return [line(m.title), episodeLabel(m)];
  return [line(m.episodeTitle ? `${m.title} · ${m.episodeTitle}` : m.title)];
}

function rank(p: PresenceView) {
  return p.status === "WATCHING" || p.publicRoom ? 0 : p.status === "ONLINE" ? 1 : 2;
}
