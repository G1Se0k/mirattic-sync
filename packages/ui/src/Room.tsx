import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import { openUrl, type FriendView, type Me, type RoomContent, type ServerEvent } from "@mirattic/types";
import { PAUSE_REQUEST_SHOWN_MS, type FollowerStatus, type RoomSyncState } from "@mirattic/sync-core";
import { api, platform, type RoomHandle } from "./session";
import { clock, PROVIDER_NAMES } from "./format";
import { Chat } from "./Chat";
import { ReportDialog } from "./Report";
import { ExperimentControl, isExperiment, useExperiment, type Experiment } from "./Experimental";
import { Avatar, IconButton } from "./Icons";
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
  /** The room list decides notifications with it: tell it at once, not at its next refetch. */
  onMuted: (muted: boolean) => void;
};

/**
 * Room screen: a view of the room's live side (`RoomHandle`). The host's player drives everyone else's; players
 * are the user's own provider pages, driven by the extension.
 */
export function Room({ roomId, me, handle, socket, status, subscribe, onClose, onMuted }: Props) {
  const s = useSyncExternalStore(handle.subscribe, handle.state);
  const [reporting, setReporting] = useState<{ id: string; name: string } | null>(null);
  const [askingPause, setAskingPause] = useState(false);
  const [inviting, setInviting] = useState(false);
  const asker = useAsk();
  const room = s.room;
  const content = room?.content;
  const isHost = room?.members.some((m) => m.user.id === me.id && m.role === "HOST") ?? false;
  const experiment = isExperiment(content?.provider) ? content.provider : undefined;
  const experimentOn = useExperiment(experiment);

  /**
   * Back to the list by the user (decision 90): the host's closes the room, asked first. The server decides who
   * hosts it now: a screen still showing me as a member gets a 409 if I host it by now, and asks me then. A
   * member just goes back (still in the room).
   */
  async function back() {
    const askClose = () => asker.ask("방을 나갈까요?", { body: "방장이 나가면 방이 종료됩니다.", ok: "나가기", danger: true });
    let confirmed = false;
    if (isHost && !(confirmed = await askClose())) return;
    for (;;) {
      try {
        if (!(await api.backFromRoom(roomId, confirmed)).closed) return onClose(); // a member: still in it
        break;
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 409 && !confirmed) {
          if (!(confirmed = await askClose())) return; // the host by now (handed to me meanwhile)
          continue;
        }
        if (status === 404) break; // already gone
        if (!confirmed) return onClose(); // a member's back goes back regardless
        return void asker.tell("방을 나가지 못했습니다", "다시 시도해 주세요."); // the room may still be open
      }
    }
    handle.exit();
    onClose();
  }

  // Closed, or no longer a member: back to the list, without a notice.
  useEffect(() => {
    if (!s.closed) return;
    handle.exit();
    onClose();
  }, [s.closed, handle, onClose]);

  // Asked on every entry while the control is off (and when the room moves to such a site). Which provider it
  // asks about: the room may switch to another provider while it is open.
  const [asking, setAsking] = useState<Experiment | null>(null);
  useEffect(() => {
    if (experiment && experimentOn === false) setAsking(experiment);
  }, [experiment, experimentOn]);

  if (!room || !content) {
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

  async function toggleMute() {
    const muted = !room!.muted;
    try {
      await api.muteRoom(roomId, muted);
      handle.setMuted(muted);
      onMuted(muted);
    } catch {
      void asker.tell("알림 설정을 바꾸지 못했습니다", "다시 시도해 주세요.");
    }
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

  const position = async () => {
    const snap = handle.state().snapshot;
    if (!snap || snap.adPlaying || snap.contentId !== content.contentId) return undefined;
    return Math.round(snap.positionMs + (snap.playing ? Date.now() - snap.capturedAt : 0));
  };

  return (
    <main className="room">
      <header className="topbar">
        <IconButton icon="back" label="친구 목록" onClick={() => void back()} />
        <h1 title={content.title}>{content.title}</h1>
        <IconButton icon="userPlus" label="방에 초대하기" onClick={() => setInviting(true)} />
        <IconButton icon={room.muted ? "bellOff" : "bell"} label={room.muted ? "채팅 알림 켜기" : "채팅 알림 끄기"}
          onClick={() => void toggleMute()} />
        <IconButton icon="logout" tone="danger" label={isHost ? "방 닫기" : "방 나가기"} onClick={() => void leave()} />
      </header>

      <div className="room-body">
        <div className="members">
          {room.members.map((m) => (
            <span key={m.user.id} className="member" title={m.role === "HOST" ? "호스트" : m.present ? "참가 중" : "초대됨"}>
              <Avatar name={m.user.displayName} on={m.present} />
              {m.user.displayName}
              {m.user.id === me.id && <span className="muted">(나)</span>}
              {m.role === "HOST" && <span className="muted">· 호스트</span>}
              {m.user.id !== me.id && (
                <IconButton icon="flag" label="신고" onClick={() => setReporting({ id: m.user.id, name: m.user.displayName })} />
              )}
              {isHost && m.user.id !== me.id && (
                <>
                  <IconButton icon="crown" label="호스트 넘기기" onClick={() => void manage(m.user.displayName, "host", m.user.id)} />
                  <IconButton icon="userMinus" tone="danger" label="내보내기" onClick={() => void manage(m.user.displayName, "kick", m.user.id)} />
                </>
              )}
            </span>
          ))}
        </div>
        <PlayerStatus content={content} s={s} isHost={isHost} experimentOff={!!experiment && experimentOn === false}
          onRequestPause={() => setAskingPause(true)} />
      </div>

      <Chat roomId={roomId} meId={me.id} members={room.members} isHost={isHost} socket={socket} status={status}
        subscribe={subscribe} position={position} onSeek={isHost && s.canPlay ? (ms) => handle.seek(ms) : undefined} />

      {reporting && <ReportDialog target={{ userId: reporting.id }} user={reporting} onClose={() => setReporting(null)} />}
      {asker.dialog}
      {asking && asking === experiment && (
        <Dialog title={`${PROVIDER_NAMES[experiment]} 제어 (실험)`} onClose={() => setAsking(null)}>
          <ExperimentControl provider={experiment} onDone={() => setAsking(null)} />
        </Dialog>
      )}
      {s.switched && s.switched.contentId === content.contentId && <Switched content={s.switched} handle={handle} />}
      {inviting && (
        <Invite roomId={roomId} code={room.code} isHost={isHost} memberIds={room.members.map((m) => m.user.id)}
          onClose={() => setInviting(false)} />
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
function Invite({ roomId, code, isHost, memberIds, onClose }: {
  roomId: string;
  code?: string;
  isHost: boolean;
  memberIds: string[];
  onClose: () => void;
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

/** A provider plays in the user's own page (e.g. a YouTube tab); this only shows where it stands. */
function PlayerStatus({ content, s, isHost, experimentOff, onRequestPause }: {
  content: RoomContent;
  s: RoomSyncState;
  isHost: boolean;
  experimentOff: boolean;
  onRequestPause: () => void;
}) {
  const name = PROVIDER_NAMES[content.provider];
  const url = openUrl(content);
  const snapshot = s.snapshot;
  const here = snapshot?.contentId === content.contentId;
  const cooldown = Math.ceil((s.pauseCooldownUntil - Date.now()) / 1000);
  // Offered only once the player has been away from the room's video for a moment: never while entering
  // the room or while the tab is still moving to the next episode.
  const offerOpen = !!url && (!s.canPlay || s.away);
  return (
    <section className="card stack">
      <div className="player">
        <span className="pill">{name}</span>
        {!s.canPlay && experimentOff ? (
          <span className="muted grow">{name} 제어(실험)가 꺼져 있어 동기화하지 않습니다. 설정에서 켤 수 있습니다.</span>
        ) : !s.canPlay ? (
          <span className="muted grow">Chrome 확장 프로그램에서 함께 볼 수 있습니다.</span>
        ) : here && snapshot ? (
          <>
            <span className="time grow">{clock(snapshot.positionMs)}{snapshot.durationMs !== undefined && ` / ${clock(snapshot.durationMs)}`}</span>
            <span className="muted">{snapshot.adPlaying ? "광고 중" : snapshot.playing ? "재생 중" : "일시정지"}</span>
          </>
        ) : !s.away ? (
          <span className="muted grow">영상 확인 중…</span>
        ) : (
          <span className="muted grow">{snapshot ? "탭에서 다른 영상을 보고 있습니다." : "영상이 열린 탭이 없습니다."}</span>
        )}
        {offerOpen && <IconButton icon="external" label={`${name}에서 이 영상 열기`} onClick={() => platform.open(url!, true)} />}
        {!isHost && <IconButton icon="pause" label="일시정지 요청" disabled={cooldown > 0} onClick={onRequestPause} />}
      </div>
      {s.canPlay && (
        <p className="muted">
          {isHost ? "탭에서 재생·일시정지·이동하면 멤버에게 전달됩니다." : describeSync(s.sync, s.clockReady)}
          {!isHost && s.lastCorrection !== null && ` · 마지막 보정 ${s.lastCorrection}ms`}
          {!isHost && cooldown > 0 && ` · 일시정지 요청은 ${cooldown}초 후에 다시 보낼 수 있습니다`}
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
