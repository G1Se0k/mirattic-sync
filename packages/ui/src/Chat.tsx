import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import { REACTIONS, type ChatMessage, type RoomMemberView, type ServerEvent } from "@mirattic/types";
import { api } from "./session";
import { clock } from "./format";

type Props = {
  roomId: string;
  meId: string;
  members: RoomMemberView[];
  socket: Socket;
  status: SocketStatus;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Where the player is now, attached to what I send; undefined when unknown (no player, ad). */
  position: () => Promise<number | undefined>;
  /** Host only: jump everyone to a message's timestamp (after asking). */
  onSeek?: (positionMs: number) => void;
};

const PAGE = 100; // the server's page size: a full page means there may be more
const NEAR_BOTTOM_PX = 40;

export function Chat({ roomId, meId, members, socket, status, subscribe, position, onSeek }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unseen, setUnseen] = useState(false); // new messages below while reading older ones
  const list = useRef<HTMLUListElement>(null);
  const atBottom = useRef(true);
  const shown = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });

  // History on open and after every reconnect (messages sent meanwhile never reached us).
  useEffect(() => {
    if (status !== "open") return;
    // Merged, not replaced: live messages may arrive before the history does.
    api.messages(roomId).then((history) => {
      setMessages((live) => merge(history, live));
      setHasOlder((more) => more || history.length === PAGE);
    }, () => {});
  }, [roomId, status]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "chat:message" || event.roomId !== roomId) return;
        const m = event.payload as ChatMessage;
        setMessages((list) => merge(list, [m]));
      }),
    [roomId, subscribe],
  );

  // Older messages keep the view where it was; new ones follow the bottom only if the user is there.
  useLayoutEffect(() => {
    const el = list.current;
    const prev = shown.current;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1];
    if (el) {
      if (first !== prev.first && last?.id === prev.last) el.scrollTop += el.scrollHeight - prev.height;
      else if (last?.id !== prev.last) {
        if (atBottom.current || last?.userId === meId) el.scrollTo({ top: el.scrollHeight });
        else setUnseen(true);
      }
    }
    shown.current = { first, last: last?.id, height: el?.scrollHeight ?? 0 };
  }, [messages, meId]);

  function onScroll() {
    const el = list.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current) setUnseen(false);
  }

  async function loadOlder() {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const page = await api.messages(roomId, oldest.id);
      setMessages((list) => merge(page, list));
      setHasOlder(page.length === PAGE);
    } catch {
      // stays offered: the next click retries
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (socket.send({ type: "chat:message", roomId, payload: { text: trimmed, mediaPositionMs: await position() } })) setText("");
  }

  async function react(emoji: string) {
    socket.send({ type: "reaction:add", roomId, payload: { emoji, mediaPositionMs: await position() } });
  }

  function jump(ms: number) {
    // Never seek on a click alone: it moves everyone in the room.
    if (onSeek && confirm(`${clock(ms)} 위치로 이동할까요? 방의 모든 사람이 함께 이동합니다.`)) onSeek(ms);
  }

  const name = (id: string) => (id === meId ? "나" : members.find((m) => m.user.id === id)?.user.displayName ?? "나간 사용자");
  const timestamp = (ms: number | undefined) =>
    ms === undefined ? null
      : onSeek ? <button className="link code" title="이 위치로 이동" onClick={() => jump(ms)}>{clock(ms)}</button>
      : <span className="muted code">{clock(ms)}</span>;

  return (
    <section className="stack">
      <h2>채팅</h2>
      <ul className="list chat" ref={list} onScroll={onScroll}>
        {hasOlder && (
          <li>
            <button className="link" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "불러오는 중…" : "이전 메시지 더 보기"}
            </button>
          </li>
        )}
        {messages.length === 0 && <li className="muted">아직 메시지가 없습니다.</li>}
        {group(messages).map((item) =>
          "userIds" in item ? (
            <li key={item.id} className="reaction" title={item.userIds.map(name).join(", ")}>
              <span className="emoji">{item.emoji}</span>
              {item.userIds.length > 1 && <span className="muted"> ×{item.userIds.length}</span>} {timestamp(item.positionMs)}
            </li>
          ) : (
            <li key={item.id}>
              <strong>{name(item.userId)}</strong> {timestamp(item.mediaPositionMs)}{" "}
              <span className="message">{item.text}</span>
            </li>
          ),
        )}
      </ul>
      {unseen && (
        <button className="link" onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight })}>새 메시지 ↓</button>
      )}
      <div className="row">
        {REACTIONS.map((emoji) => (
          <button key={emoji} className="link emoji" title="지금 위치에 리액션" disabled={status !== "open"} onClick={() => void react(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
      <form className="row" onSubmit={send}>
        <input className="grow" placeholder="메시지" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={status !== "open"}>보내기</button>
      </form>
    </section>
  );
}

/** Union by id, oldest first (id breaks ties, as the server pages). */
export function merge(a: ChatMessage[], b: ChatMessage[]) {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export type ReactionGroup = { id: string; emoji: string; positionMs?: number; userIds: string[] };

/** Within this much of a run's first reaction, the same emoji joins it: "😂 ×4 · 24:32". */
const REACTION_RUN_MS = 10_000;

/** Messages as shown: back-to-back reactions with the same emoji at about the same moment become one line. */
export function group(messages: ChatMessage[]): (ChatMessage | ReactionGroup)[] {
  const out: (ChatMessage | ReactionGroup)[] = [];
  for (const m of messages) {
    if (!m.reaction) {
      out.push(m);
      continue;
    }
    const run = out[out.length - 1];
    const near = (a?: number, b?: number) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) <= REACTION_RUN_MS);
    if (run && "userIds" in run && run.emoji === m.text && near(run.positionMs, m.mediaPositionMs)) run.userIds.push(m.userId);
    else out.push({ id: m.id, emoji: m.text, positionMs: m.mediaPositionMs, userIds: [m.userId] });
  }
  return out;
}
