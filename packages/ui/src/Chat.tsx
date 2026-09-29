import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import type { ChatDeleted, ChatMessage, RoomMemberView, ServerEvent } from "@mirattic/types";
import { api } from "./session";
import { clock } from "./format";
import { IconButton } from "./Icons";

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
const FLASH_MS = 1600;

export function Chat({ roomId, meId, members, isHost, socket, status, subscribe, position, onSeek }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unseen, setUnseen] = useState(false); // new messages below while reading older ones
  /** Arrived live just now: highlighted for a moment. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
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
      setMessages((live) => tombstone(reconcile(history, live), deleted.current));
      setHasOlder((more) => more || history.length === PAGE);
    }, () => {});
  }, [roomId, status]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.roomId !== roomId) return;
        setMessages((list) => receive(list, deleted.current, event));
        if (event.type === "chat:message" || event.type === "chat:log") {
          const id = (event.payload as ChatMessage).id;
          setFresh((ids) => new Set(ids).add(id));
          setTimeout(() => setFresh((ids) => new Set([...ids].filter((x) => x !== id))), FLASH_MS);
        }
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
      setMessages((list) => tombstone(merge(list, page), deleted.current));
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

  async function remove(m: ChatMessage) {
    if (!confirm(m.userId === meId ? "이 메시지를 삭제할까요? 모두에게 \"삭제된 메시지입니다\"로 보입니다." : "호스트 권한으로 이 메시지를 삭제할까요?")) return;
    setFailed(null);
    // The server's chat:delete removes it here too (and on every other screen).
    await api.deleteMessage(roomId, m.id).catch(() => setFailed("메시지를 삭제하지 못했습니다."));
  }

  function jump(ms: number) {
    onSeek?.(ms); // the host's click moves everyone there
  }

  const name = (id: string) => {
    const member = members.find((m) => m.user.id === id)?.user.displayName;
    if (id === meId) return `${member ?? "나"}(나)`;
    return member ?? "나간 사용자";
  };
  const timestamp = (ms: number | undefined) =>
    ms === undefined ? null
      : onSeek ? <button className="link stamp code" title="이 위치로 이동" onClick={() => jump(ms)}>{clock(ms)}</button>
      : <span className="stamp code">{clock(ms)}</span>;

  return (
    <section className="chat-panel">
      <ul className="list chat" ref={list} onScroll={onScroll}>
        {hasOlder && (
          <li>
            <button className="link" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "불러오는 중…" : "이전 메시지"}
            </button>
          </li>
        )}
        {messages.length === 0 && <li className="muted">아직 메시지가 없습니다.</li>}
        {messages.map((item) =>
          item.kind ? (
            <li key={item.id} className={`log${fresh.has(item.id) ? " fresh" : ""}`}>
              {logText(item)} {item.kind !== "join" && item.kind !== "leave" && timestamp(item.mediaPositionMs)}
            </li>
          ) : (
            <li key={item.id} className={`row${fresh.has(item.id) ? " fresh" : ""}`}>
              <span className="grow">
                <span className="author">{name(item.userId)}</span>
                {item.deleted ? (
                  <span className="deleted">삭제된 메시지입니다</span>
                ) : (
                  <>
                    {timestamp(item.mediaPositionMs)}
                    <span className="message">{item.text}</span>
                  </>
                )}
              </span>
              {!item.deleted && (item.userId === meId || isHost) && (
                <span className="tools">
                  <IconButton icon="trash" label="삭제" onClick={() => void remove(item)} />
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {unseen && (
        <button className="link" onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight })}>새 메시지 ↓</button>
      )}
      <div className="composer">
        {failed && <p className="error" role="alert">{failed}</p>}
        <form onSubmit={send}>
          <input placeholder="메시지" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          <IconButton icon="send" label="보내기" type="submit" tone="primary" disabled={status !== "open"} />
        </form>
      </div>
    </section>
  );
}

/** Oldest first; id breaks ties, as the server pages. */
const order = (x: ChatMessage, y: ChatMessage) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Union by id, oldest first; `b` wins for an id in both, unless `a`'s copy was edited later (a moved seek line). */
export function merge(a: ChatMessage[], b: ChatMessage[]) {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) {
    const had = byId.get(m.id);
    if (!had || (m.editedAt ?? 0) >= (had.editedAt ?? 0)) byId.set(m.id, m);
  }
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
  // The page wins for the messages it has (a deletion meanwhile arrives as its placeholder); remembered
  // deletions are applied again by the caller.
  return merge(shown.filter((m) => ids.has(m.id) || order(m, last) > 0 || (first && order(m, first) < 0)), page);
}

/**
 * A live event on the shown list. Deletions are remembered (`deleted`, appended): a message whose delivery
 * was overtaken by its deletion must not come back when it arrives.
 */
export function receive(list: ChatMessage[], deleted: ChatDeleted[], event: ServerEvent) {
  // A log line may come again with the same id (a seek moved on): the newer one replaces it.
  if (event.type === "chat:message" || event.type === "chat:log") return tombstone(merge(list, [event.payload as ChatMessage]), deleted);
  if (event.type !== "chat:delete") return list;
  deleted.push(event.payload as ChatDeleted);
  return tombstone(list, [event.payload as ChatDeleted]);
}

/** Drops deleted messages: by id, or all of a deleted account's (the room list counts only what is left). */
export function without(messages: ChatMessage[], deleted: ChatDeleted[]) {
  if (deleted.length === 0) return messages;
  return messages.filter((m) => !deleted.some((d) => d.id === m.id || d.userId === m.userId));
}

/**
 * As the chat shows deletions: a deleted message stays as a placeholder (like the server keeps it), a deleted
 * account's messages go (the server removed them with the account).
 */
export function tombstone(messages: ChatMessage[], deleted: ChatDeleted[]) {
  if (deleted.length === 0) return messages;
  return messages
    .filter((m) => !deleted.some((d) => d.userId === m.userId))
    .map((m) => (deleted.some((d) => d.id === m.id) && !m.deleted ? { ...m, text: "", mediaPositionMs: undefined, deleted: true } : m));
}

/** A room log line as shown (decision 78). */
export function logText(m: ChatMessage) {
  switch (m.kind) {
    case "join": return `${m.text}님이 들어왔습니다`;
    case "leave": return `${m.text}님이 나갔습니다`;
    case "play": return "호스트가 재생했습니다";
    case "pause": return "호스트가 일시정지했습니다";
    case "seek": return "호스트가 위치를 옮겼습니다";
    case "content": return `호스트가 영상을 바꿨습니다: ${m.text}`;
    default: return "";
  }
}
