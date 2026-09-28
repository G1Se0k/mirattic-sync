import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import { openUrl, sameSeries, type Me, type MediaProviderAdapter, type PlaybackState, type PlayerSnapshot, type RoomContent, type RoomView, type ServerEvent } from "@mirattic/types";
import { MockMediaProvider, publishHost, ServerClock, SyncFollower, type FollowerStatus } from "@mirattic/sync-core";
import { api, platform } from "./session";
import { clock, latest as latestOnly, PROVIDER_NAMES } from "./format";
import { Chat } from "./Chat";
import { ReportDialog } from "./Report";
import { ExperimentControl, isExperiment, useExperiment, type Experiment } from "./Experimental";

/** "room|provider" already asked about in this session: the dialog comes up once per room and provider, not on every entry. */
const askedExperiment = new Set<string>();

type Props = {
  roomId: string;
  me: Me;
  socket: Socket;
  status: SocketStatus;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onClose: (note?: string) => void;
  /** The room list decides notifications with it: tell it at once, not at its next refetch. */
  onMuted: (muted: boolean) => void;
};

const CLOCK_SAMPLES = 5;

/**
 * Room screen: the host's player drives everyone else's. A mock room plays a fake video right here;
 * other providers play in the user's own provider page, driven through `platform.adapter`.
 */
export function Room({ roomId, me, socket, status, subscribe, onClose, onMuted }: Props) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [clockReady, setClockReady] = useState(false);
  const [sync, setSync] = useState<FollowerStatus | null>(null);
  const [lastCorrection, setLastCorrection] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [reporting, setReporting] = useState<{ id: string; name: string } | null>(null);
  const serverClock = useMemo(() => new ServerClock(), []);
  const latest = useRef<PlaybackState | null>(null);
  const follower = useRef<SyncFollower | null>(null);
  const sentAt = useRef(new Map<string, number>());

  const content = room?.content;
  const isHost = room?.members.some((m) => m.user.id === me.id && m.role === "HOST") ?? false;
  const mock = content?.provider === "mock";
  const experiment = isExperiment(content?.provider) ? content.provider : undefined;
  const experimentOn = useExperiment(experiment);
  const player: MediaProviderAdapter | undefined = useMemo(
    () =>
      !content ? undefined
        : mock ? new MockMediaProvider({ contentId: content.contentId, title: content.title, durationMs: content.durationMs ?? 600_000 })
        : platform.adapter?.(content.provider),
    [content?.provider, mock && content?.contentId, experimentOn],
  );
  // Which provider the dialog asks about: the room may switch to another provider while it is open.
  const [asking, setAsking] = useState<Experiment | null>(null);
  useEffect(() => {
    const key = `${roomId}|${experiment}`;
    if (!experiment || experimentOn !== false || askedExperiment.has(key)) return;
    askedExperiment.add(key);
    setAsking(experiment);
  }, [experiment, experimentOn, roomId]);
  // The content the host last announced. Set from the room only when the room's content changes, so a
  // render between announcing and the room refetch can't make the host announce (and reset) it twice.
  const announced = useRef<RoomContent | null>(null);
  useEffect(() => {
    announced.current = content ?? null;
  }, [content?.provider, content?.contentId, content?.series]);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);

  // A member whose host moved to another video: the next one of the same series (playlist, show) opens by
  // itself; anything else is asked (plan.md decision 67). Not on entering the room, nor if it is already open.
  const [switched, setSwitched] = useState<RoomContent | null>(null);
  const shown = useRef<RoomContent | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = content ?? null;
    if (!content || !before || isHost || mock || !player) return;
    if (before.provider === content.provider && before.contentId === content.contentId) return;
    const url = openUrl(content);
    if (!url) return;
    let current = true; // the room may move on again before the tab answers
    void player.getSnapshot().then((s) => {
      if (!current || s?.contentId === content.contentId) return;
      if (sameSeries(before, content)) platform.open(url);
      else setSwitched(content);
    });
    return () => void (current = false);
  }, [content?.provider, content?.contentId]);
  // The same video joining a playlist mid-way: remember its series without asking anything.
  useEffect(() => {
    const before = shown.current;
    if (content && before?.provider === content.provider && before.contentId === content.contentId) shown.current = content;
  }, [content?.series]);

  // Loads answer in any order: only the latest started one applies, and a newer local change (mute) drops those in flight.
  const roomLoads = useMemo(() => latestOnly(), []);
  const setMuted = (muted: boolean) => {
    roomLoads.invalidate();
    setRoom((r) => r && { ...r, muted });
  };
  useEffect(() => {
    const load = () => {
      const fresh = roomLoads.begin();
      return api.room(roomId).then(
        (r) => {
          if (!fresh()) return;
          setRoom(r);
          setLoadFailed(false);
        },
        (e) => {
          if (!fresh()) return;
          if (e instanceof ApiError && e.status === 404) onClose("방이 닫혔거나 더 이상 멤버가 아닙니다.");
          else setLoadFailed(true);
        },
      );
    };
    void load();
    return subscribe((event) => {
      if (event.roomId && event.roomId !== roomId) return;
      if (event.type === "room:update") {
        // Muted from another app of mine: the value comes along, applied before the refetch returns.
        const muted = (event.payload as { muted?: unknown } | null)?.muted;
        if (typeof muted === "boolean") setMuted(muted);
        void load();
      }
      if (event.type === "playback:update") {
        const state = event.payload as PlaybackState;
        if (state.version > (latest.current?.version ?? -1)) latest.current = state;
        follower.current?.apply(state);
      }
      if (event.type === "sync:response") {
        const reqId = (event.payload as { reqId: string }).reqId;
        const at = sentAt.current.get(reqId);
        if (at === undefined) return;
        sentAt.current.delete(reqId);
        serverClock.addSample(at, event.serverTime);
        setClockReady(true);
      }
    });
  }, [roomId, subscribe, onClose, serverClock, attempt, roomLoads]);

  // (Re)join and re-measure the clock on every (re)connect: the server forgets joins on disconnect.
  useEffect(() => {
    if (status !== "open") return;
    socket.send({ type: "room:join", roomId, payload: {} });
    const timers = Array.from({ length: CLOCK_SAMPLES }, (_, i) =>
      setTimeout(() => {
        const reqId = `clock-${Date.now()}-${i}`;
        sentAt.current.set(reqId, Date.now());
        socket.send({ type: "sync:request", reqId, payload: null });
      }, i * 200),
    );
    return () => {
      timers.forEach(clearTimeout);
      socket.send({ type: "room:leave", roomId, payload: {} });
    };
  }, [status, socket, roomId]);

  // Host publishes local changes; members follow the room state.
  const connected = status === "open";
  useEffect(() => {
    if (!player || !room || !clockReady) return;
    if (isHost) {
      // Changes made offline would be lost; restarting on reconnect republishes the current state.
      if (!connected) return;
      return publishHost(player, serverClock, (type, payload, snapshot, gone) => {
        // The video went away: pause the members on the content they are following, never on a new one.
        if (gone) return snapshot.contentId === announced.current?.contentId && socket.send({ type, roomId, payload });
        if (!mock) {
          // The command is about `snapshot`'s video. Its metadata ("now watching") arrives with the change
          // event; until then, skip — that event triggers another send.
          const now = platform.nowWatching?.();
          if (!now || now.contentId !== snapshot.contentId) return false;
          // Also the same video joining a playlist (series): the server then keeps the playback as it is.
          if (now.contentId !== announced.current?.contentId || now.series !== announced.current?.series) {
            socket.send({ type: "playback:content-change", roomId, payload: now });
            announced.current = now;
          }
        }
        return socket.send({ type, roomId, payload });
      });
    }
    const f = new SyncFollower({
      adapter: player,
      clock: serverClock,
      onStatus: (s) => {
        setSync(s);
        if (s.kind === "corrected") setLastCorrection(Math.round(s.driftMs));
      },
    });
    follower.current = f;
    if (latest.current) f.apply(latest.current);
    return () => {
      f.stop();
      follower.current = null;
    };
  }, [player, isHost, clockReady, room !== null, isHost && connected]);

  useEffect(() => {
    const id = setInterval(() => {
      tick((n) => n + 1);
      if (player && !mock) void player.getSnapshot().then(setSnapshot);
    }, mock ? 250 : 1000);
    return () => clearInterval(id);
  }, [player, mock]);

  if (!room) {
    return (
      <main className="container">
        {loadFailed ? (
          <p className="row">
            방을 불러오지 못했습니다.
            <button className="link" onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>
            <button className="link" onClick={() => onClose()}>← 친구 목록</button>
          </p>
        ) : (
          "방 불러오는 중…"
        )}
      </main>
    );
  }

  async function toggleMute() {
    const muted = !room!.muted;
    try {
      await api.muteRoom(roomId, muted);
      setMuted(muted);
      onMuted(muted);
    } catch {
      alert("알림 설정을 바꾸지 못했습니다. 다시 시도해 주세요.");
    }
  }

  async function leave() {
    const message = isHost ? "방을 닫을까요? 모든 멤버가 나가게 됩니다." : "방에서 나갈까요?";
    if (!confirm(message)) return;
    try {
      await api.leaveRoom(roomId);
    } catch (e) {
      // 404: already gone. Anything else: the room may still be open, so stay and let the user retry.
      if (!(e instanceof ApiError && e.status === 404)) return alert("방을 나가지 못했습니다. 다시 시도해 주세요.");
    }
    onClose();
  }

  return (
    <main className="container">
      <header className="row between">
        <button className="link" onClick={() => onClose()}>← 친구 목록</button>
        <div className="row">
          <button className="link" onClick={() => void toggleMute()} title="다른 화면에 있을 때 이 방의 새 메시지 알림">
            {room.muted ? "🔕 채팅 알림 켜기" : "🔔 채팅 알림 끄기"}
          </button>
          <button className="link danger" onClick={leave}>{isHost ? "방 닫기" : "방 나가기"}</button>
        </div>
      </header>
      <h1>{room.content.title}</h1>
      {asking && asking === experiment && (
        <dialog open className="stack">
          <h2>{PROVIDER_NAMES[experiment]} 제어 (실험)</h2>
          <ExperimentControl provider={experiment} onDone={() => setAsking(null)} />
        </dialog>
      )}
      <ul className="list">
        {room.members.map((m) => (
          <li key={m.user.id} className="friend">
            <span className={`dot ${m.present ? "on" : ""}`} />
            <span className="grow">{m.user.displayName}{m.user.id === me.id && " (나)"}</span>
            <span className="muted">{m.role === "HOST" ? "호스트" : m.present ? "참가 중" : "초대됨"}</span>
            {m.user.id !== me.id && (
              <button className="link small" onClick={() => setReporting({ id: m.user.id, name: m.user.displayName })}>신고</button>
            )}
          </li>
        ))}
      </ul>
      {switched && switched.contentId === room.content.contentId && (
        <dialog open className="stack">
          <h2>호스트가 영상을 바꿨습니다</h2>
          <p>{switched.title}</p>
          <div className="row">
            <button onClick={() => { platform.open(openUrl(switched)!); setSwitched(null); }}>이 영상 열기</button>
            <button className="link" onClick={() => setSwitched(null)}>나중에</button>
          </div>
        </dialog>
      )}
      {reporting && <ReportDialog target={{ userId: reporting.id }} user={reporting} onClose={() => setReporting(null)} />}

      {player instanceof MockMediaProvider ? (
        <MockPlayer player={player} isHost={isHost} clockReady={clockReady} sync={describeSync(sync, clockReady)} lastCorrection={lastCorrection} />
      ) : (
        <ProviderPlayer content={room.content} snapshot={snapshot} canPlay={player !== undefined} isHost={isHost}
          sync={describeSync(sync, clockReady)} lastCorrection={lastCorrection} experimentOff={!!experiment && experimentOn === false} />
      )}
      <Chat roomId={roomId} meId={me.id} members={room.members} isHost={isHost} socket={socket} status={status} subscribe={subscribe}
        position={async () => {
          const s = await player?.getSnapshot();
          return s && !s.adPlaying && s.contentId === room.content.contentId ? Math.round(s.positionMs) : undefined;
        }}
        onSeek={isHost && player && player.seekable !== false ? (ms) => void player.seek(ms) : undefined} />
    </main>
  );
}

type PlayerProps = { isHost: boolean; sync: string; lastCorrection: number | null };

function MockPlayer({ player, isHost, clockReady, sync, lastCorrection }: PlayerProps & { player: MockMediaProvider; clockReady: boolean }) {
  const position = player.positionMs();
  const duration = player.content.durationMs;
  const nudge = (ms: number) => () => void player.seek(player.positionMs() + ms);
  return (
      <section className="stack">
        <h2>Mock 플레이어</h2>
        <progress className="grow" max={duration} value={position} />
        <div className="row between">
          <span className="code">{clock(position)} / {clock(duration)}</span>
          <span className="muted">{player.isPlaying() ? "재생 중" : "일시정지"}</span>
        </div>
        {isHost ? (
          <div className="row">
            <button onClick={() => void (player.isPlaying() ? player.pause() : player.play())} disabled={!clockReady}>
              {player.isPlaying() ? "일시정지" : "재생"}
            </button>
            <button onClick={nudge(-10_000)} disabled={!clockReady}>-10초</button>
            <button onClick={nudge(10_000)} disabled={!clockReady}>+10초</button>
          </div>
        ) : (
          <>
            <p className="muted">
              {sync}
              {lastCorrection !== null && ` · 마지막 보정 ${lastCorrection}ms`}
            </p>
            <div className="row">
              <span className="muted">어긋나게 하기:</span>
              <button className="link" onClick={nudge(800)}>+0.8초</button>
              <button className="link" onClick={nudge(-2_000)}>-2초</button>
              <button className="link" onClick={nudge(-5_000)}>-5초</button>
            </div>
          </>
        )}
      </section>
  );
}

/** A real provider plays in the user's own page (e.g. a YouTube tab); this only shows where it stands. */
function ProviderPlayer({ content, snapshot, canPlay, isHost, sync, lastCorrection, experimentOff }: PlayerProps & {
  content: RoomContent;
  snapshot: PlayerSnapshot | null;
  canPlay: boolean;
  experimentOff: boolean;
}) {
  const url = openUrl(content);
  const here = snapshot?.contentId === content.contentId;
  return (
    <section className="stack">
      <h2>{PROVIDER_NAMES[content.provider]}</h2>
      {!canPlay && experimentOff ? (
        <p className="muted">{PROVIDER_NAMES[content.provider]} 제어(실험)가 꺼져 있어 동기화하지 않습니다. 친구 목록 아래 "실험 기능"에서 켤 수 있습니다.</p>
      ) : !canPlay ? (
        <p className="muted">이 방은 Chrome 확장 프로그램의 side panel에서 함께 볼 수 있습니다.</p>
      ) : here && snapshot ? (
        <div className="row between">
          <span className="code">{clock(snapshot.positionMs)}{snapshot.durationMs !== undefined && ` / ${clock(snapshot.durationMs)}`}</span>
          <span className="muted">{snapshot.adPlaying ? "광고 중" : snapshot.playing ? "재생 중" : "일시정지"}</span>
        </div>
      ) : (
        <p className="muted">{snapshot ? "탭에서 다른 영상을 보고 있습니다." : "영상이 열린 탭이 없습니다."}</p>
      )}
      {url && (!canPlay || !here) && (
        <button onClick={() => platform.open(url)}>{PROVIDER_NAMES[content.provider]}에서 이 영상 열기</button>
      )}
      {canPlay && (
        <p className="muted">
          {isHost ? "탭에서 직접 재생·일시정지·이동하면 멤버에게 전달됩니다. 다른 영상으로 옮기면 방도 따라갑니다." : sync}
          {!isHost && lastCorrection !== null && ` · 마지막 보정 ${lastCorrection}ms`}
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
