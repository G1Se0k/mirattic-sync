import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Socket, type SocketStatus } from "@mirattic/client";
import type { Me, PlaybackState, RoomView, ServerEvent } from "@mirattic/types";
import { MockMediaProvider, publishHost, ServerClock, SyncFollower, type FollowerStatus } from "@mirattic/sync-core";
import { api } from "./session";
import { clock } from "./format";

type Props = {
  roomId: string;
  me: Me;
  socket: Socket;
  status: SocketStatus;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onClose: (note?: string) => void;
};

const CLOCK_SAMPLES = 5;

/** Phase 2 room screen: a mock player kept in sync with the host. No real media involved. */
export function Room({ roomId, me, socket, status, subscribe, onClose }: Props) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [clockReady, setClockReady] = useState(false);
  const [sync, setSync] = useState<FollowerStatus | null>(null);
  const [lastCorrection, setLastCorrection] = useState<number | null>(null);
  const [, tick] = useState(0);
  const serverClock = useMemo(() => new ServerClock(), []);
  const latest = useRef<PlaybackState | null>(null);
  const follower = useRef<SyncFollower | null>(null);
  const sentAt = useRef(new Map<string, number>());

  const content = room?.content;
  const isHost = room?.members.some((m) => m.user.id === me.id && m.role === "HOST") ?? false;
  const player = useMemo(
    () => content && new MockMediaProvider({ contentId: content.contentId, title: content.title, durationMs: content.durationMs ?? 600_000 }),
    [content?.contentId],
  );

  useEffect(() => {
    const load = () =>
      api.room(roomId).then(
        (r) => {
          setRoom(r);
          setLoadFailed(false);
        },
        (e) => {
          if (e instanceof ApiError && e.status === 404) onClose("방이 닫혔거나 더 이상 멤버가 아닙니다.");
          else setLoadFailed(true);
        },
      );
    void load();
    return subscribe((event) => {
      if (event.roomId && event.roomId !== roomId) return;
      if (event.type === "room:update") void load();
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
  }, [roomId, subscribe, onClose, serverClock, attempt]);

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
      return publishHost(player, serverClock, (type, payload) => socket.send({ type, roomId, payload }));
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
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  if (!room || !player) {
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

  const position = player.positionMs();
  const duration = player.content.durationMs;
  const nudge = (ms: number) => () => void player.seek(player.positionMs() + ms);

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
        <button className="link danger" onClick={leave}>{isHost ? "방 닫기" : "방 나가기"}</button>
      </header>
      <h1>{room.content.title}</h1>
      <ul className="list">
        {room.members.map((m) => (
          <li key={m.user.id} className="friend">
            <span className={`dot ${m.present ? "on" : ""}`} />
            <span className="grow">{m.user.displayName}{m.user.id === me.id && " (나)"}</span>
            <span className="muted">{m.role === "HOST" ? "호스트" : m.present ? "참가 중" : "초대됨"}</span>
          </li>
        ))}
      </ul>

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
              {describeSync(sync, clockReady)}
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
    </main>
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
  }
}
