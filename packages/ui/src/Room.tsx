import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import { contentKey, MEDIA_PROVIDERS, memberLimitOf, watchUrl, type FriendView, type MediaProvider, type Me, type RoomContent, type RoomMemberView, type ServerEvent } from "@mirattic/types";
import { PAUSE_REQUEST_SHOWN_MS, showsRoomVideo, type FollowerStatus, type RoomSyncState } from "@mirattic/sync-core";
import { api, platform, type RoomHandle, type VideoTab } from "./session";
import { clock, PROVIDER_NAMES } from "./format";
import { Chat } from "./Chat";
import { ReportDialog } from "./Report";
import { ExperimentControl, isExperiment, useExperiment, type Experiment } from "./Experimental";
import { Avatar, IconButton, PanelWindowButton, ProviderIcon, Icon } from "./Icons";
import { Actions, Dialog, TimeBar, useAsk } from "./Dialog";

/** "room|user" → when the last invite went out: the same friend can be invited again after 30 s. */
const invitedAt = new Map<string, number>();
const INVITE_COOLDOWN_MS = 30_000;

type Props = {
  roomId: string;
  me: Me;
  handle: RoomHandle;
  socket: Socket;
  status: SocketStatus;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Back to the list; the extension stays in the room. */
  onClose: () => void;
  /** A friend was invited: it may answer their watch request to me, which the server tells only them (`watch:answer`). */
  onInvited: () => void;
};

/**
 * Room screen: a view of the room's live side (`RoomHandle`). The host's player drives everyone else's; players
 * are the user's own provider pages, driven by the extension.
 */
export function Room({ roomId, me, handle, socket, status, subscribe, onClose, onInvited }: Props) {
  const s = useSyncExternalStore(handle.subscribe, handle.state);
  const [reporting, setReporting] = useState<{ id: string; name: string } | null>(null);
  const [askingPause, setAskingPause] = useState(false);
  const [inviting, setInviting] = useState(false);
  const asker = useAsk();
  const room = s.room;
  const content = room?.content;
  const isHost = room?.members.some((m) => m.user.id === me.id && m.role === "HOST") ?? false;
  // Decision 106: the room's member limit, the host included; full, nobody more can be invited.
  const limit = room ? memberLimitOf(room) : 8;
  const full = !!room && room.members.length >= limit;
  // The room's type (decision 93): the host's pick, else its video's site; the warning below is about it.
  const roomType: MediaProvider | null = room?.type ?? content?.provider ?? null;
  const experiment = isExperiment(roomType ?? undefined) ? (roomType as Experiment) : undefined;
  const experimentOn = useExperiment(experiment);

  /**
   * Back to the list (decision 90, changed 2026-10-04 at the user's request): for the host too, the room stays —
   * like closing the panel, the background keeps it. The host closes it with 방 닫기 here or on its row in the list.
   */
  const back = () => onClose();

  // Closed, or no longer a member: back to the list, without a notice.
  useEffect(() => {
    if (!s.closed) return;
    handle.exit();
    onClose();
  }, [s.closed, handle, onClose]);

  // Asked on every entry while the control is off (and when the room moves to such a site). Which provider it
  // asks about: the room may switch to another provider while it is open, or the host may pick one (`pending`).
  const [asking, setAsking] = useState<Experiment | null>(null);
  useEffect(() => {
    if (experiment && experimentOn === false) setAsking(experiment);
  }, [experiment, experimentOn]);

  /** The host picks a site: the room's type changes (members told), and its tab here is followed or it opens. */
  const [pendingSite, setPendingSite] = useState<MediaProvider | null>(null);
  const typeWrites = useRef<Promise<void>>(Promise.resolve());
  /** `turnedOn`: its control was just turned on here (the shared state saying so may not be back yet). */
  function pickSite(site: MediaProvider, turnedOn = false) {
    if (isExperiment(site) && !turnedOn && !platform.experimental?.enabled(site)) {
      setPendingSite(site); // turned on first (asked), then picked
      return setAsking(site);
    }
    platform.tabs?.openSite(site); // the extension looks its tab up (or opens the site) and follows it
    // Always told (the view may be behind a pick still in flight), one after another so the last pick lands last;
    // the same type changes nothing on the server.
    typeWrites.current = typeWrites.current.then(() => api.setRoomType(roomId, site))
      .catch(() => void asker.tell("방 플랫폼을 바꾸지 못했습니다", "다시 시도해 주세요."));
  }

  if (!room) {
    return (
      <main className="room">
        <header className="topbar">
          <IconButton icon="back" label="친구 목록" onClick={() => void back()} />
          <h1>{s.loadFailed ? "방을 불러오지 못했습니다" : "불러오는 중…"}</h1>
          {s.loadFailed && <IconButton icon="refresh" label="다시 시도" onClick={() => handle.retry()} />}
        </header>
        {asker.dialog /* back may ask the host here too */}
      </main>
    );
  }

  /** Host only (decision 79). The room's refetch (room:update) shows the result. */
  async function manage(name: string, action: "host" | "kick", userId: string) {
    const yes = action === "host"
      ? await asker.ask(`${name}님에게 호스트를 넘길까요?`, { body: `이후 재생은 ${name}님의 플레이어를 따라갑니다.`, ok: "호스트 넘기기" })
      : await asker.ask(`${name}님을 방에서 내보낼까요?`, { body: "다시 초대하기 전에는 방 코드로도 들어올 수 없습니다.", ok: "내보내기", danger: true });
    if (!yes) return;
    try {
      await (action === "host" ? api.makeHost(roomId, userId) : api.kickMember(roomId, userId));
    } catch {
      void asker.tell(action === "host" ? "호스트를 넘기지 못했습니다" : "내보내지 못했습니다", "다시 시도해 주세요.");
    }
  }

  async function leave() {
    const yes = isHost
      ? await asker.ask("방을 닫을까요?", { body: "모든 멤버가 나가게 됩니다.", ok: "방 닫기", danger: true })
      : await asker.ask("방에서 나갈까요?", { ok: "나가기", danger: true });
    if (!yes) return;
    try {
      await api.leaveRoom(roomId);
    } catch (e) {
      // 404: already gone. Anything else: the room may still be open, so stay and let the user retry.
      if (!(e instanceof ApiError && e.status === 404)) return void asker.tell("방을 나가지 못했습니다", "다시 시도해 주세요.");
    }
    handle.exit();
    onClose();
  }

  /**
   * A member not agreeing to the room's site leaves (the dialog asked): as a member only — handed the host meanwhile,
   * the server refuses (409) instead of closing the room for everyone. Back to the list once left.
   */
  async function leaveNow() {
    try {
      await api.leaveRoom(roomId, true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        return void asker.tell("방장이 되어 방에 남았습니다", "방을 닫으려면 방 닫기를 누르세요.");
      }
      if (!(e instanceof ApiError && e.status === 404)) return void asker.tell("방을 나가지 못했습니다", "다시 시도해 주세요.");
    }
    handle.exit();
    onClose();
  }

  const position = async () => {
    const snap = handle.state().snapshot;
    if (!content || !snap || snap.adPlaying || snap.contentId !== content.contentId) return undefined;
    return Math.round(snap.positionMs + (snap.playing ? Date.now() - snap.capturedAt : 0));
  };

  return (
    <main className="room">
      <header className="topbar">
        <IconButton icon="back" label="친구 목록" onClick={() => void back()} />
        <h1 title={content?.title}>{content?.title ?? "새 방"}</h1>
        <PanelWindowButton />
        {full
          ? <IconButton icon="userPlus" label={`방이 가득 찼습니다 (최대 ${limit}명)`} disabled onClick={() => {}} />
          : <IconButton icon="userPlus" label="방에 초대하기" onClick={() => setInviting(true)} />}
        <IconButton icon="logout" tone="danger" label={isHost ? "방 닫기" : "방 나가기"} onClick={() => void leave()} />
      </header>

      <div className="room-body">
        <PlayerStatus content={content ?? null} s={s} isHost={isHost} experimentOff={!!experiment && experimentOn === false}
          roomType={roomType} onPickSite={pickSite} onRequestPause={() => setAskingPause(true)} />
        {isHost && <TabPicker type={roomType} />}
        <Members members={room.members} meId={me.id} isHost={isHost} limit={limit}
          onReport={(id, name) => setReporting({ id, name })}
          onManage={(name, action, id) => void manage(name, action, id)} />
      </div>

      <Chat roomId={roomId} meId={me.id} members={room.members} isHost={isHost} socket={socket} status={status}
        subscribe={subscribe} position={position} onSeek={isHost && showsRoomVideo(s, content) ? (ms) => handle.seek(ms) : undefined}
        canStamp={showsRoomVideo(s, content) && (isHost || s.hostVideo !== false)}
        video={content ? contentKey(content) : undefined} videoMs={content?.durationMs} />

      {reporting && <ReportDialog target={{ userId: reporting.id }} user={reporting} onClose={() => setReporting(null)} />}
      {asker.dialog}
      {asking && (asking === experiment || asking === pendingSite) && (
        // A member answers it (agree, or leave); the host may just close it.
        <Dialog title={`${PROVIDER_NAMES[asking]} 제어 (실험)`}
          onClose={isHost ? () => { setAsking(null); setPendingSite(null); } : undefined}>
          {/* A member who doesn't agree leaves the room (it is on that site now); the host's own pick just stops. */}
          <ExperimentControl provider={asking} declineLabel={isHost ? "켜지 않고 계속" : "동의하지 않음"} onDone={(turnedOn) => {
            // A member not agreeing leaves; the warning stays until that succeeds (a failure leaves it to answer again).
            if (!turnedOn && !isHost && asking === experiment) return void leaveNow();
            const site = pendingSite;
            setAsking(null);
            setPendingSite(null);
            if (turnedOn && site === asking) pickSite(site, true);
          }} />
        </Dialog>
      )}
      {s.switched && s.switched.provider === content?.provider && s.switched.contentId === content.contentId
        && <Switched content={s.switched} handle={handle} />}
      {inviting && (
        <Invite roomId={roomId} code={room.code} isHost={isHost} memberIds={room.members.map((m) => m.user.id)}
          onClose={() => setInviting(false)} onInvited={onInvited} />
      )}
      {askingPause && <RequestPause handle={handle} onClose={() => setAskingPause(false)} />}
      {s.pauseRequest && isHost && <PauseRequest request={s.pauseRequest} handle={handle} />}
    </main>
  );
}

/** A member asks the host to pause; it closes by itself (sync-core) 30 s after it came, counted down here. */
function PauseRequest({ request, handle }: { request: NonNullable<RoomSyncState["pauseRequest"]>; handle: RoomHandle }) {
  return (
    <Dialog alert title={`${request.name}님이 일시정지를 요청했습니다`} onClose={() => handle.dismissPauseRequest()}>
      {request.reason && <p>{request.reason}</p>}
      <Actions>
        <button className="link" onClick={() => handle.dismissPauseRequest()}>닫기</button>
        <button onClick={() => handle.pauseAll()}>모두 일시정지</button>
      </Actions>
      <TimeBar key={request.at} until={request.at + PAUSE_REQUEST_SHOWN_MS} total={PAUSE_REQUEST_SHOWN_MS} />
    </Dialog>
  );
}

/** Friends to invite (host only, as on the server), then the room's code for anyone. */
function Invite({ roomId, code, isHost, memberIds, onClose, onInvited }: {
  roomId: string;
  code?: string;
  isHost: boolean;
  memberIds: string[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const shown = code && `${code.slice(0, 4)}-${code.slice(4)}`;

  useEffect(() => {
    if (isHost) api.friends().then(setFriends, () => setError("친구 목록을 불러오지 못했습니다."));
  }, [isHost]);
  // Re-render each second so a "초대됨" turns back into "초대" when its 30 s are up.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function invite(userId: string) {
    setError(null);
    invitedAt.set(`${roomId}|${userId}`, Date.now());
    tick((n) => n + 1);
    try {
      await api.inviteToRoom(roomId, [userId]);
      onInvited();
    } catch (e) {
      invitedAt.delete(`${roomId}|${userId}`);
      setError(e instanceof ApiError && e.status === 409 ? "방이 가득 찼습니다." : "초대하지 못했습니다.");
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(shown!);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog title="방에 초대하기" onClose={onClose}>
      {isHost && (
        <>
          {friends?.length === 0 && <p className="muted">친구가 없습니다.</p>}
          <ul className="list">
            {friends?.map((f) => {
              const inRoom = memberIds.includes(f.user.id);
              const recent = Date.now() - (invitedAt.get(`${roomId}|${f.user.id}`) ?? 0) < INVITE_COOLDOWN_MS;
              return (
                <li key={f.user.id} className="friend">
                  <Avatar name={f.user.displayName} />
                  <span className="grow name">{f.user.displayName}</span>
                  {inRoom || recent ? (
                    <button className="secondary" disabled>{inRoom ? "방에 있음" : "초대됨"}</button>
                  ) : (
                    <button onClick={() => void invite(f.user.id)}>초대</button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {shown && (
        <>
          <p className="muted">{isHost ? "또는 방 코드로 초대" : "방 코드로 초대"}</p>
          <div className="card row">
            <code className="code grow">{shown}</code>
            <IconButton icon={copied ? "check" : "copy"} label={copied ? "복사됨" : "복사"} onClick={() => void copy()} />
          </div>
        </>
      )}
      <Actions><button className="link" onClick={onClose}>닫기</button></Actions>
    </Dialog>
  );
}

function Switched({ content, handle }: { content: RoomContent; handle: RoomHandle }) {
  const [always, setAlways] = useState(false);
  return (
    <Dialog title="호스트가 영상을 바꿨습니다" onClose={() => handle.dismissSwitched()}>
      <p>{content.title}</p>
      <label className="row check">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <span>이 방에서 항상 허용하기 (다음부터 묻지 않고 따라감)</span>
      </label>
      <Actions>
        <button className="link" onClick={() => handle.dismissSwitched()}>나중에</button>
        <button onClick={() => handle.openSwitched(always)}>이 영상 열기</button>
      </Actions>
    </Dialog>
  );
}

/** Only the host pauses the room: a member asks, with an optional reason. */
function RequestPause({ handle, onClose }: { handle: RoomHandle; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title="일시정지 요청" onClose={onClose}>
      <p className="muted">호스트에게 알림이 갑니다. 30초에 한 번 보낼 수 있습니다.</p>
      <textarea placeholder="사유 (선택)" maxLength={200} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Actions>
        <button className="link" onClick={onClose}>취소</button>
        <button onClick={() => { handle.requestPause(reason); onClose(); }}>요청 보내기</button>
      </Actions>
    </Dialog>
  );
}

const noSubscribe = () => () => {};
const NO_TABS: VideoTab[] = [];

/**
 * The host picks the tab the room follows — one tab (stays, whichever is active), or the active one as they switch —
 * among the tabs of the room's type (all video tabs while it has none).
 */
function TabPicker({ type }: { type: MediaProvider | null }) {
  const tabs = platform.tabs;
  const subscribe = platform.subscribe ?? noSubscribe;
  const all = useSyncExternalStore(subscribe, () => tabs?.list() ?? NO_TABS);
  const list = useMemo(() => (type ? all.filter((t) => t.provider === type) : all), [all, type]);
  const followed = useSyncExternalStore(subscribe, () => tabs?.followed() ?? null);
  const auto = useSyncExternalStore(subscribe, () => tabs?.auto() ?? false);
  const [open, setOpen] = useState(false);
  if (!tabs) return null;
  const current = list.find((t) => t.id === followed);
  const chosen = auto ? "활성 탭 자동 따라가기" : current?.title ?? (followed !== null ? "영상이 없는 탭 또는 다른 창의 탭" : "없음");
  return (
    // A card like the members': its line shows the choice; it unfolds the options.
    <section className="card">
      <button type="button" className="card-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="label">인식할 탭</span>
        <span className="value ellipsis">{chosen}</span>
        <Icon name="chevron" />
      </button>
      <div className={`fold${open ? "" : " closed"}`} inert={!open}>
      <div>
      {/* Native radios (arrow keys move between them), drawn as the app's buttons with the chosen one marked; in the
          tab strip's order, automatic always last. */}
      <div className="stack tab-options" role="radiogroup" aria-label="인식할 탭">
        {list.map((t) => (
          <label key={t.id} title={t.title} className="tab-option">
            <input type="radio" name="followed-tab" checked={!auto && t.id === followed} onChange={() => tabs.choose(t.id)} />
            <span className="ellipsis grow">{t.title}</span>
            {t.id === followed && <span className="muted">인식 중</span>}
          </label>
        ))}
        {list.length === 0 && <p className="muted">{type ? `${PROVIDER_NAMES[type]} 탭이 없습니다.` : "YouTube · 켜진 실험 사이트의 탭이 없습니다."}</p>}
        <label className="tab-option">
          <input type="radio" name="followed-tab" checked={auto} onChange={() => tabs.choose(null)} />
          <span className="grow">활성 탭 자동 따라가기</span>
        </label>
      </div>
      </div>
      </div>
    </section>
  );
}

const MEMBERS_OPEN_KEY = "mirattic.membersOpen";

/**
 * The room's members (decision 106): a "멤버" line with a segment per seat (red once full) that folds the list
 * (remembered on this device), and chips with the avatar and name. A chip opens a small box over it — on top of what
 * comes before, nothing moves: the name ("(나)" for me), "호스트", and its actions — report (not me), hand the room over
 * and remove (the host, on someone else).
 */
function Members({ members, meId, isHost, limit, onReport, onManage }: {
  members: RoomMemberView[];
  meId: string;
  isHost: boolean;
  limit: number;
  onReport: (id: string, name: string) => void;
  onManage: (name: string, action: "host" | "kick", id: string) => void;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(MEMBERS_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [picked, setPicked] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const full = members.length >= limit;
  const shown = members.find((m) => m.user.id === picked);

  function toggle() {
    const next = !open;
    setOpen(next);
    setPicked(null);
    try {
      localStorage.setItem(MEMBERS_OPEN_KEY, next ? "1" : "0");
    } catch {
      // not kept: open again next time
    }
  }

  // Over its chip (the list is the last thing above the chat), kept inside the list's width.
  useLayoutEffect(() => {
    const chip = list.current?.querySelector<HTMLElement>(`[data-member="${picked}"]`);
    const el = box.current;
    if (!chip || !el || !list.current) return;
    el.style.left = `${Math.max(0, Math.min(chip.offsetLeft, list.current.clientWidth - el.offsetWidth))}px`;
    el.style.top = `${chip.offsetTop - el.offsetHeight - 4}px`;
  }, [picked, members]);

  // Opened: focus in it and in view (the panel may be short); closed by the keyboard or an action: back to its chip.
  useEffect(() => {
    if (!picked) return;
    box.current?.focus({ preventScroll: true });
    box.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  function closeBox() {
    list.current?.querySelector<HTMLElement>(`[data-member="${picked}"]`)?.focus();
    setPicked(null);
  }

  // Closed by a click elsewhere, Escape, or a resize (the chips may wrap elsewhere).
  useEffect(() => {
    if (!picked) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") closeBox();
      } else if (!wrap.current?.contains(e.target as Node)) setPicked(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    const shut = () => setPicked(null);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("resize", shut);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [picked]);

  return (
    <section className="card">
      <button type="button" className={`members-head${full ? " full" : ""}`} aria-expanded={open}
        aria-label={`멤버 ${members.length}/${limit}명${full ? ", 가득 참" : ""}, ${open ? "접기" : "펼치기"}`} onClick={toggle}>
        <span className="label">멤버</span>
        <span className="gauge" aria-hidden="true">
          {Array.from({ length: limit }, (_, i) => <i key={i} className={i < members.length ? "on" : undefined} />)}
        </span>
        <span className="count">{members.length} / {limit}{full && " · 가득 참"}</span>
      </button>
      {/* Folds smoothly (kept rendered, out of reach while folded); the box sits outside the fold so it isn't clipped. */}
      <div className="members-wrap" ref={wrap}>
        <div className={`fold${open ? "" : " closed"}`} inert={!open}>
          <div>{/* folds to 0, the list's padding with it */}
          <div className="members" ref={list}>
            {members.map((m) => (
          <button key={m.user.id} type="button" className="member" data-member={m.user.id} aria-haspopup="dialog"
            aria-expanded={picked === m.user.id} title={m.present ? "참가 중" : "방 밖"}
            onClick={() => setPicked((p) => (p === m.user.id ? null : m.user.id))}>
            <Avatar name={m.user.displayName} on={m.present} />
            {m.user.displayName}
          </button>
            ))}
          </div>
          </div>
        </div>
        {shown && (
          <div className="member-box" ref={box} tabIndex={-1} role="dialog" aria-label={`${shown.user.displayName} 메뉴`}>
            <span className="who">
              {shown.user.displayName}{shown.user.id === meId && " (나)"}
              {shown.role === "HOST" && <span className="muted"> · 호스트</span>}
            </span>
            {shown.user.id !== meId && (
              <span className="row">
                <IconButton icon="flag" label="신고" onClick={() => { closeBox(); onReport(shown.user.id, shown.user.displayName); }} />
                {isHost && (
                  <>
                    <IconButton icon="crown" label="호스트 넘기기" onClick={() => { closeBox(); onManage(shown.user.displayName, "host", shown.user.id); }} />
                    <IconButton icon="userMinus" tone="danger" label="내보내기" onClick={() => { closeBox(); onManage(shown.user.displayName, "kick", shown.user.id); }} />
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** The room's type as its site's icon; the host's opens the list of sites to switch the room to. */
function RoomType({ type, onPick }: { type: MediaProvider | null; onPick?: (site: MediaProvider) => void }) {
  // Where it opens: fixed under the button, so the scrolling room body doesn't clip it under the chat.
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    document.addEventListener("click", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true); // anything scrolled: it would float away from the button
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);
  const icon = type ? <ProviderIcon provider={type} /> : <span className="provider none" title="플랫폼 없음">·</span>;
  if (!onPick) return icon;
  return (
    <span className="menu">
      <button type="button" className="type-button" title="방 플랫폼 바꾸기" aria-label="방 플랫폼 바꾸기" aria-haspopup="menu"
        aria-expanded={!!open} onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((o) => (o ? null : { top: r.bottom + 4, left: r.left }));
        }}>
        {icon}
      </button>
      {open && (
        <div className="menu-items left" role="menu" style={{ position: "fixed", top: open.top, left: open.left }}>
          {MEDIA_PROVIDERS.map((site) => (
            <button key={site} role="menuitem" onClick={() => { setOpen(null); onPick(site); }}>
              <ProviderIcon provider={site} /> {PROVIDER_NAMES[site]}
              {site === type && <span className="muted">· 지금</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** A provider plays in the user's own page (e.g. a YouTube tab); this only shows where it stands. */
function PlayerStatus({ content, s, isHost, experimentOff, roomType, onPickSite, onRequestPause }: {
  /** null: no video yet (decision 92). */
  content: RoomContent | null;
  s: RoomSyncState;
  isHost: boolean;
  experimentOff: boolean;
  roomType: MediaProvider | null;
  onPickSite: (site: MediaProvider) => void;
  onRequestPause: () => void;
}) {
  const followed = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.tabs?.followed() ?? null);
  const type = <RoomType type={roomType} onPick={isHost ? onPickSite : undefined} />;
  if (!content) {
    // No "이 영상 열기": there is no video to open.
    return (
      <section className="card stack">
        <div className="player">
          {type}
          <span className="muted grow">
            {isHost ? "아직 방 영상이 없습니다. 인식할 탭에서 영상을 열면 방 영상이 됩니다." : "아직 방 영상이 없습니다. 방장이 영상을 열면 시작됩니다."}
          </span>
        </div>
      </section>
    );
  }
  const name = PROVIDER_NAMES[content.provider];
  const url = watchUrl(content);
  const snapshot = s.snapshot;
  const here = snapshot?.contentId === content.contentId;
  const cooldown = Math.ceil((s.pauseCooldownUntil - Date.now()) / 1000);
  // Offered only once the player has been away from the room's video for a moment: never while entering
  // the room or while the tab is still moving to the next episode. Not once the room's type moved on to another
  // site (decision 93): the room has no video of its site yet, and the old one isn't what it watches.
  const offerOpen = !!url && (!s.canPlay || s.away) && (!roomType || roomType === content.provider);
  return (
    <section className="card stack">
      <div className="player">
        {type}
        {!s.canPlay && experimentOff ? (
          <span className="muted grow">{name} 제어(실험)가 꺼져 있어 동기화하지 않습니다. 설정에서 켤 수 있습니다.</span>
        ) : !s.canPlay ? (
          <span className="muted grow">Chrome 확장 프로그램에서 함께 볼 수 있습니다.</span>
        ) : !isHost && s.hostVideo === false ? (
          // The host's browser shows no room video (decision 105): they're looking for the next one.
          <span className="muted grow">호스트가 영상을 고르고 있습니다.</span>
        ) : here && snapshot ? (
          <>
            <span className="time grow">{clock(snapshot.positionMs)}{snapshot.durationMs !== undefined && ` / ${clock(snapshot.durationMs)}`}</span>
            <span className="muted">{snapshot.adPlaying ? "광고 중" : snapshot.playing ? "재생 중" : "일시정지"}</span>
          </>
        ) : !s.away ? (
          <span className="muted grow">영상 확인 중…</span>
        ) : (
          <span className="muted grow">
            {snapshot ? "탭에서 다른 영상을 보고 있습니다." : followed !== null ? "인식 중인 탭에 영상이 없습니다." : "인식 중인 탭이 없습니다."}
          </span>
        )}
        {offerOpen && <IconButton icon="external" label={`${name}에서 이 영상 열기`} onClick={() => platform.open(url!, true)} />}
        {!isHost && <IconButton icon="pause" label="일시정지 요청" disabled={cooldown > 0} onClick={onRequestPause} />}
      </div>
      {s.canPlay && !isHost && (
        <p className="muted">
          {describeSync(s.sync, s.clockReady)}
          {cooldown > 0 && ` · 일시정지 요청은 ${cooldown}초 후에 다시 보낼 수 있습니다`}
        </p>
      )}
    </section>
  );
}

function describeSync(s: FollowerStatus | null, clockReady: boolean) {
  if (!clockReady) return "서버 시계 맞추는 중…";
  if (!s) return "호스트 상태 기다리는 중…";
  const ms = "driftMs" in s ? Math.round(s.driftMs) : 0;
  switch (s.kind) {
    case "synced": return `동기화됨 (차이 ${ms}ms)`;
    case "rechecking": return `차이 ${ms}ms · 허용 범위, 계속 확인 중`;
    case "confirming": return `차이 ${ms}ms · 잠시 후 다시 확인하고 맞춤`;
    case "corrected": return `차이 ${ms}ms → 호스트 위치로 맞춤`;
    case "ad": return "광고 중 · 동기화 일시 중지";
    case "other-content": return "다른 콘텐츠 재생 중";
    case "waiting": return "플레이어 기다리는 중…";
    case "manual": return `호스트보다 ${Math.abs(s.driftMs / 1000).toFixed(1)}초 ${s.driftMs < 0 ? "늦음" : "빠름"} · 직접 ${clock(s.targetMs)}(으)로 이동해 주세요`;
  }
}
