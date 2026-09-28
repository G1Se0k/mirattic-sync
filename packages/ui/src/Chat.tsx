import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import { REACTIONS, type ChatDeleted, type ChatMessage, type RoomMemberView, type ServerEvent } from "@mirattic/types";
import { api } from "./session";
import { clock } from "./format";
import { ReportDialog } from "./Report";

type Props = {
  roomId: string;
  meId: string;
  members: RoomMemberView[];
  /** The host may delete anyone's message (moderation); others only their own. */
  isHost: boolean;
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

export function Chat({ roomId, meId, members, isHost, socket, status, subscribe, position, onSeek }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unseen, setUnseen] = useState(false); // new messages below while reading older ones
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Deleted while their history was loading: a history answered before the delete must not bring them back. */
  const deleted = useRef<ChatDeleted[]>([]);
  const list = useRef<HTMLUListElement>(null);
  const atBottom = useRef(true);
  const shown = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });

  // History on open and after every reconnect (messages sent meanwhile never reached us).
  useEffect(() => {
    if (status !== "open") return;
    // Merged, not replaced: live messages may arrive before the history does.
    api.messages(roomId).then((history) => {
      setMessages((live) => without(reconcile(history, live), deleted.current));
      setHasOlder((more) => more || history.length === PAGE);
    }, () => {});
  }, [roomId, status]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.roomId === roomId) setMessages((list) => receive(list, deleted.current, event));
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
      setMessages((list) => without(merge(page, list), deleted.current));
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

  async function remove(m: ChatMessage) {
    if (!confirm(m.userId === meId ? "이 메시지를 삭제할까요? 모든 사람의 화면에서 사라집니다." : "호스트 권한으로 이 메시지를 삭제할까요?")) return;
    setFailed(null);
    // The server's chat:delete removes it here too (and on every other screen).
    await api.deleteMessage(roomId, m.id).catch(() => setFailed("메시지를 삭제하지 못했습니다."));
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
              <span className="message">{item.text}</span>{" "}
              {(item.userId === meId || isHost) && (
                <button className="link small" title="메시지 삭제" onClick={() => void remove(item)}>삭제</button>
              )}
              {item.userId !== meId && (
                <button className="link small" title="메시지 신고" onClick={() => setReporting(item)}>신고</button>
              )}
            </li>
          ),
        )}
      </ul>
      {failed && <p className="error" role="alert">{failed}</p>}
      {reporting && (
        <ReportDialog target={{ messageId: reporting.id }} user={{ id: reporting.userId, name: name(reporting.userId) }}
          onClose={() => setReporting(null)} />
      )}
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

/** Oldest first; id breaks ties, as the server pages. */
const order = (x: ChatMessage, y: ChatMessage) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Union by id, oldest first. */
export function merge(a: ChatMessage[], b: ChatMessage[]) {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort(order);
}

/**
 * The latest page (after a reconnect) against what is shown: a shown message within the page's span but
 * missing from it was deleted while we were away. Newer ones may have arrived live after the page was read.
 * A short page reaches back to the room's first message, so its span has no lower end.
 */
export function reconcile(page: ChatMessage[], shown: ChatMessage[]) {
  const last = page[page.length - 1];
  if (!last) return shown; // ponytail: can't tell deleted from just-arrived; the next reconnect or reopen settles it
  const ids = new Set(page.map((m) => m.id));
  const first = page.length === PAGE ? page[0] : undefined;
  return merge(page, shown.filter((m) => ids.has(m.id) || order(m, last) > 0 || (first && order(m, first) < 0)));
}

/**
 * A live event on the shown list. Deletions are remembered (`deleted`, appended): a message whose delivery
 * was overtaken by its deletion must not come back when it arrives.
 */
export function receive(list: ChatMessage[], deleted: ChatDeleted[], event: ServerEvent) {
  if (event.type === "chat:message") return without(merge(list, [event.payload as ChatMessage]), deleted);
  if (event.type !== "chat:delete") return list;
  deleted.push(event.payload as ChatDeleted);
  return without(list, [event.payload as ChatDeleted]);
}

/** Drops deleted messages: by id, or all of a deleted account's. */
export function without(messages: ChatMessage[], deleted: ChatDeleted[]) {
  if (deleted.length === 0) return messages;
  return messages.filter((m) => !deleted.some((d) => d.id === m.id || d.userId === m.userId));
}

export type ReactionGroup = { id: string; emoji: string; positionMs?: number; sentAt: number; userIds: string[] };

/**
 * The same emoji joins a run ("😂 ×4 · 24:32") when sent within this much of the run's first reaction and
 * at a video position within this much of it (the line shows one timestamp).
 */
const REACTION_RUN_MS = 10_000;

/** Messages as shown: back-to-back reactions with the same emoji, sent together at about the same moment, become one line. */
export function group(messages: ChatMessage[]): (ChatMessage | ReactionGroup)[] {
  const out: (ChatMessage | ReactionGroup)[] = [];
  for (const m of messages) {
    if (!m.reaction) {
      out.push(m);
      continue;
    }
    const run = out[out.length - 1];
    const near = (a?: number, b?: number) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) <= REACTION_RUN_MS);
    if (run && "userIds" in run && run.emoji === m.text && m.createdAt - run.sentAt <= REACTION_RUN_MS && near(run.positionMs, m.mediaPositionMs)) {
      run.userIds.push(m.userId);
    } else out.push({ id: m.id, emoji: m.text, positionMs: m.mediaPositionMs, sentAt: m.createdAt, userIds: [m.userId] });
  }
  return out;
}
