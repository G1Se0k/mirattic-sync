import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import { openUrl, type Me, type RoomContent, type ServerEvent } from "@mirattic/types";
import type { FollowerStatus, RoomSyncState } from "@mirattic/sync-core";
import { api, platform, type RoomHandle } from "./session";
import { clock, PROVIDER_NAMES } from "./format";
import { Chat } from "./Chat";
import { ReportDialog } from "./Report";
import { ExperimentControl, isExperiment, useExperiment, type Experiment } from "./Experimental";
import { Avatar, IconButton } from "./Icons";

/** "room|provider" already asked about in this session: the dialog comes up once per room and provider, not on every entry. */
const askedExperiment = new Set<string>();

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
  const room = s.room;
  const content = room?.content;
  const isHost = room?.members.some((m) => m.user.id === me.id && m.role === "HOST") ?? false;
  const experiment = isExperiment(content?.provider) ? content.provider : undefined;
  const experimentOn = useExperiment(experiment);

  // Closed, or no longer a member: back to the list, without a notice.
  useEffect(() => {
    if (!s.closed) return;
    handle.exit();
    onClose();
  }, [s.closed, handle, onClose]);

  // Which provider the dialog asks about: the room may switch to another provider while it is open.
  const [asking, setAsking] = useState<Experiment | null>(null);
  useEffect(() => {
    const key = `${roomId}|${experiment}`;
    if (!experiment || experimentOn !== false || askedExperiment.has(key)) return;
    askedExperiment.add(key);
    setAsking(experiment);
  }, [experiment, experimentOn, roomId]);

  if (!room || !content) {
    return (
      <main className="room">
        <header className="topbar">
          <IconButton icon="back" label="친구 목록" onClick={onClose} />
          <h1>{s.loadFailed ? "방을 불러오지 못했습니다" : "불러오는 중…"}</h1>
          {s.loadFailed && <IconButton icon="refresh" label="다시 시도" onClick={() => handle.retry()} />}
        </header>
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
      alert("알림 설정을 바꾸지 못했습니다. 다시 시도해 주세요.");
    }
  }

  async function leave() {
    if (!confirm(isHost ? "방을 닫을까요? 모든 멤버가 나가게 됩니다." : "방에서 나갈까요?")) return;
    try {
      await api.leaveRoom(roomId);
    } catch (e) {
      // 404: already gone. Anything else: the room may still be open, so stay and let the user retry.
      if (!(e instanceof ApiError && e.status === 404)) return alert("방을 나가지 못했습니다. 다시 시도해 주세요.");
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
        <IconButton icon="back" label="친구 목록" onClick={onClose} />
        <h1 title={content.title}>{content.title}</h1>
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
            </span>
          ))}
        </div>
        <PlayerStatus content={content} s={s} isHost={isHost} experimentOff={!!experiment && experimentOn === false}
          onRequestPause={() => setAskingPause(true)} />
      </div>

      <Chat roomId={roomId} meId={me.id} members={room.members} isHost={isHost} socket={socket} status={status}
        subscribe={subscribe} position={position} onSeek={isHost && s.canPlay ? (ms) => handle.seek(ms) : undefined} />

      {reporting && <ReportDialog target={{ userId: reporting.id }} user={reporting} onClose={() => setReporting(null)} />}
      {asking && asking === experiment && (
        <dialog open className="stack">
          <h2>{PROVIDER_NAMES[experiment]} 제어 (실험)</h2>
          <ExperimentControl provider={experiment} onDone={() => setAsking(null)} />
        </dialog>
      )}
      {s.switched && s.switched.contentId === content.contentId && <Switched content={s.switched} handle={handle} />}
      {askingPause && <RequestPause handle={handle} onClose={() => setAskingPause(false)} />}
      {s.pauseRequest && isHost && (
        <dialog open className="stack" role="alertdialog">
          <h2>{s.pauseRequest.name}님이 일시정지를 요청했습니다</h2>
          {s.pauseRequest.reason && <p>{s.pauseRequest.reason}</p>}
          <p className="muted">30초 후에 자동으로 닫힙니다.</p>
          <div className="row">
            <button className="secondary" onClick={() => handle.dismissPauseRequest()}>닫기</button>
            <button onClick={() => handle.pauseAll()}>모두 일시정지</button>
          </div>
        </dialog>
      )}
    </main>
  );
}

function Switched({ content, handle }: { content: RoomContent; handle: RoomHandle }) {
  return (
    <dialog open className="stack">
      <h2>호스트가 영상을 바꿨습니다</h2>
      <p>{content.title}</p>
      <div className="row">
        <button className="secondary" onClick={() => handle.dismissSwitched()}>나중에</button>
        <button onClick={() => handle.openSwitched()}>이 영상 열기</button>
      </div>
    </dialog>
  );
}

/** Only the host pauses the room: a member asks, with an optional reason. */
function RequestPause({ handle, onClose }: { handle: RoomHandle; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <dialog open className="stack">
      <h2>일시정지 요청</h2>
      <p className="muted">호스트에게 알림이 갑니다. 30초에 한 번 보낼 수 있습니다.</p>
      <textarea placeholder="사유 (선택)" maxLength={200} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button className="secondary" onClick={onClose}>취소</button>
        <button onClick={() => { handle.requestPause(reason); onClose(); }}>요청 보내기</button>
      </div>
    </dialog>
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
        {offerOpen && <IconButton icon="external" label={`${name}에서 이 영상 열기`} onClick={() => platform.open(url!)} />}
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
