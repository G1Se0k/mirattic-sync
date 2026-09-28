import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import type { ChatMessage, RoomMemberView, ServerEvent } from "@mirattic/types";
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

export function Chat({ roomId, meId, members, socket, status, subscribe, position, onSeek }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const list = useRef<HTMLUListElement>(null);

  // History on open and after every reconnect (messages sent meanwhile never reached us).
  useEffect(() => {
    if (status !== "open") return;
    // Merged, not replaced: live messages may arrive before the history does.
    api.messages(roomId).then((history) => setMessages((live) => merge(history, live)), () => {});
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

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (socket.send({ type: "chat:message", roomId, payload: { text: trimmed, mediaPositionMs: await position() } })) setText("");
  }

  function jump(ms: number) {
    // Never seek on a click alone: it moves everyone in the room.
    if (onSeek && confirm(`${clock(ms)} 위치로 이동할까요? 방의 모든 사람이 함께 이동합니다.`)) onSeek(ms);
  }

  const name = (id: string) => members.find((m) => m.user.id === id)?.user.displayName ?? "나간 사용자";

  return (
    <section className="stack">
      <h2>채팅</h2>
      <ul className="list chat" ref={list}>
        {messages.length === 0 && <li className="muted">아직 메시지가 없습니다.</li>}
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.userId === meId ? "나" : name(m.userId)}</strong>{" "}
            {m.mediaPositionMs !== undefined &&
              (onSeek ? (
                <button className="link code" title="이 위치로 이동" onClick={() => jump(m.mediaPositionMs!)}>
                  {clock(m.mediaPositionMs)}
                </button>
              ) : (
                <span className="muted code">{clock(m.mediaPositionMs)}</span>
              ))}{" "}
            <span className="message">{m.text}</span>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={send}>
        <input className="grow" placeholder="메시지" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={status !== "open"}>보내기</button>
      </form>
    </section>
  );
}

/** Union by id, oldest first. */
export function merge(a: ChatMessage[], b: ChatMessage[]) {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt);
}
