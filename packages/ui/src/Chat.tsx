import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import type { ChatDeleted, ChatMessage, RoomMemberView, ServerEvent } from "@mirattic/types";
import { api } from "./session";
import { clock, parseClock } from "./format";
import { IconButton } from "./Icons";
import { Actions, Dialog, useAsk } from "./Dialog";

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
  /** The room's video (`contentKey`): a timestamp moves playback only on the video it was taken on; none: no stamping. */
  video?: string;
  /** Its length, where known: a stamp past it isn't sent. */
  videoMs?: number;
};

const PAGE = 100; // the server's page size: a full page means there may be more
const NEAR_BOTTOM_PX = 40;
const FLASH_MS = 1600;
const STAMP_WAIT_MS = 5000;

export function Chat({ roomId, meId, members, isHost, socket, status, subscribe, position, onSeek, video, videoMs }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const shownLines = useMemo(() => messages.filter(visible), [messages]);
  const [text, setText] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unseen, setUnseen] = useState(false); // new messages below while reading older ones
  /** Arrived live just now: highlighted for a moment. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const asker = useAsk();
  const [failed, setFailed] = useState<string | null>(null);
  /** The stamp dialog's time as typed; null = closed. */
  const [stamping, setStamping] = useState<string | null>(null);
  /** The video the dialog was opened on: its time is that video's. */
  const stampVideo = useRef<string | undefined>(undefined);
  /** This dialog's attempt: a retry of the same time is the same request (posted once, answered again). */
  const stampAttempt = useRef("");
  const [stampError, setStampError] = useState<string | null>(null);
  /**
   * The stamp sent (its `reqId`), until the server answers it — `chat:stamp` (posted: the dialog closes) or an `error`
   * — or STAMP_WAIT_MS pass. Only this attempt's answer counts: one for an earlier, given-up attempt doesn't.
   */
  const stampWait = useRef<{ reqId: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [stampSending, setStampSending] = useState(false);
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
        const answered = (event.payload as { reqId?: string } | null)?.reqId;
        if (stampWait.current && answered === stampWait.current.reqId) {
          if (event.type === "chat:stamp") closeStamp(); // posted
          else if (event.type === "error") stampFailed();
        }
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
  useEffect(() => () => clearTimeout(stampWait.current?.timer), []);

  // Older messages keep the view where it was; new ones (and a line grown in place) follow the bottom only if the
  // user is there.
  useLayoutEffect(() => {
    const el = list.current;
    const prev = shown.current;
    const last = shownLines[shownLines.length - 1];
    const next = { first: shownLines[0]?.id, last: last?.id, height: el?.scrollHeight ?? 0 };
    const action = el ? scrollFor(prev, next, atBottom.current, last?.userId === meId) : null;
    if (action === "keep") el!.scrollTop += next.height - prev.height;
    else if (action === "bottom") el!.scrollTo({ top: next.height });
    else if (action === "unseen") setUnseen(true);
    shown.current = next;
  }, [shownLines, meId]);

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
    // With the video the position is on (the room's as this panel knows it): kept only while it is the room's.
    if (socket.send({ type: "chat:message", roomId, payload: { text: trimmed, mediaPositionMs: await position(), contentKey: video } })) setText("");
  }

  async function openStamp() {
    const on = video;
    const at = await position();
    stampVideo.current = on;
    stampAttempt.current = `stamp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStampError(null);
    setStamping(at === undefined ? "" : clock(at)); // where the player is now, to keep or change
  }

  function closeStamp() {
    clearTimeout(stampWait.current?.timer);
    stampWait.current = undefined;
    setStampSending(false);
    setStamping(null);
  }

  /** Not posted (refused, or no answer in time): the dialog stays with the time typed. */
  function stampFailed() {
    clearTimeout(stampWait.current?.timer);
    stampWait.current = undefined;
    setStampSending(false);
    setStampError("타임스탬프를 찍지 못했습니다. 시간을 확인하고 다시 시도해 주세요.");
  }

  function stamp(e: FormEvent) {
    e.preventDefault();
    if (stampWait.current) return;
    // The room moved on to another video meanwhile: the time shown was the previous one's.
    if (stampVideo.current !== video) return setStampError("방 영상이 바뀌었습니다. 창을 닫고 다시 열어 주세요.");
    const ms = parseClock(stamping ?? "");
    if (ms === null) return setStampError("시간을 3:28이나 1:02:03처럼 입력해 주세요.");
    if (videoMs !== undefined && ms > videoMs) return setStampError(`영상 길이(${clock(videoMs)}) 안의 시간을 입력해 주세요.`);
    const reqId = `${stampAttempt.current}-${ms}`;
    const on = stampVideo.current; // the video the time is on (checked above to be the room's now)
    if (!socket.send({ type: "chat:stamp", reqId, roomId, payload: { mediaPositionMs: ms, contentKey: on } })) return setStampError("연결되면 다시 시도해 주세요.");
    // Open until the server answers: it may still refuse it (the room's video changed meanwhile).
    setStampError(null);
    setStampSending(true);
    stampWait.current = { reqId, timer: setTimeout(stampFailed, STAMP_WAIT_MS) };
  }

  async function remove(m: ChatMessage) {
    const yes = m.userId === meId
      ? await asker.ask("이 메시지를 삭제할까요?", { body: "모두에게 \"삭제된 메시지입니다\"로 보입니다.", ok: "삭제", danger: true })
      : await asker.ask("호스트 권한으로 이 메시지를 삭제할까요?", { ok: "삭제", danger: true });
    if (!yes) return;
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
  // Moves playback only on the video it was taken on (a line from before the room's video changed: just a time).
  const timestamp = (ms: number | undefined, key: string | undefined) =>
    ms === undefined ? null
      : onSeek && key !== undefined && key === video
        ? <button className="link stamp code" title="이 위치로 이동" onClick={() => jump(ms)}>{clock(ms)}</button>
        : <span className="stamp code">{clock(ms)}</span>;

  return (
    <section className="chat-panel">
      {asker.dialog}
      <ul className="list chat" ref={list} onScroll={onScroll}>
        {hasOlder && (
          <li>
            <button className="link" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "불러오는 중…" : "이전 메시지"}
            </button>
          </li>
        )}
        {shownLines.length === 0 && !hasOlder && <li className="muted">아직 메시지가 없습니다.</li>}
        {shownLines.map((item) =>
          item.kind ? (
            <li key={item.id} className={`log${fresh.has(item.id) ? " fresh" : ""}`}>
              {item.kind === "stamp" && item.mediaPositionMs !== undefined ? (
                <>{item.text}님이 {timestamp(item.mediaPositionMs, item.contentKey)}에 스탬프를 찍었습니다</>
              ) : (
                logText(item)
              )}
            </li>
          ) : (
            <li key={item.id} className={`row${fresh.has(item.id) ? " fresh" : ""}`}>
              <span className="grow">
                <span className="author">{name(item.userId)}</span>
                {item.deleted ? (
                  <span className="deleted">삭제된 메시지입니다</span>
                ) : (
                  <>
                    {timestamp(item.mediaPositionMs, item.contentKey)}
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
          <IconButton icon="clock" label="타임스탬프 찍기" disabled={status !== "open" || !video} onClick={() => void openStamp()} />
          <IconButton icon="send" label="보내기" type="submit" tone="primary" disabled={status !== "open"} />
        </form>
      </div>
      {stamping !== null && (
        <Dialog title="타임스탬프 찍기" onClose={closeStamp}>
          <form className="stack" onSubmit={stamp}>
            <p className="muted">채팅에 모두에게 남습니다. 지금 위치를 그대로 찍거나 시간을 고쳐서 찍을 수 있습니다.</p>
            <input id="stamp-time" aria-label="시간" placeholder="0:00" inputMode="numeric" autoFocus value={stamping}
              onChange={(e) => setStamping(e.target.value)} />
            {stampError && <p className="error" role="alert">{stampError}</p>}
            <Actions>
              <button type="button" className="link" onClick={closeStamp}>취소</button>
              <button type="submit" disabled={status !== "open" || stampSending}>{stampSending ? "찍는 중…" : "찍기"}</button>
            </Actions>
          </form>
        </Dialog>
      )}
    </section>
  );
}

/** Oldest first; id breaks ties, as the server pages. */
const order = (x: ChatMessage, y: ChatMessage) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Union by id, oldest first; `b` wins for an id in both. */
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
  // The page wins for the messages it has (a deletion meanwhile arrives as its placeholder); remembered
  // deletions are applied again by the caller.
  return merge(shown.filter((m) => ids.has(m.id) || order(m, last) > 0 || (first && order(m, first) < 0)), page);
}

/**
 * A live event on the shown list. Deletions are remembered (`deleted`, appended): a message whose delivery
 * was overtaken by its deletion must not come back when it arrives.
 */
export function receive(list: ChatMessage[], deleted: ChatDeleted[], event: ServerEvent) {
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

/**
 * Shown in the chat: messages and the log lines this version knows — not a kind it has no text for (an older server's
 * play / pause / seek, decision 103, or a newer one's).
 */
export function visible(m: ChatMessage) {
  return !m.kind || logText(m) !== "";
}

type Shown = { first?: string; last?: string; height: number };

/**
 * What the chat's scroll does after the lines changed: older ones loaded above keep the view ("keep"); a new last line
 * follows the bottom if the user is there or wrote it ("bottom"), else says there is more below ("unseen"); lines
 * changed in place that changed the height (a video-change line retitled into two lines) follow the bottom too, if the
 * user is there.
 */
export function scrollFor(prev: Shown, next: Shown, atBottom: boolean, mine: boolean): "keep" | "bottom" | "unseen" | null {
  if (next.first !== prev.first && next.last === prev.last) return "keep";
  if (next.last !== prev.last) return atBottom || mine ? "bottom" : "unseen";
  return atBottom && next.height !== prev.height ? "bottom" : null;
}

/** A room log line as shown (decision 78). */
export function logText(m: ChatMessage) {
  switch (m.kind) {
    case "join": return `${m.text}님이 들어왔습니다`;
    case "leave": return `${m.text}님이 나갔습니다`;
    case "content": return `호스트가 영상을 바꿨습니다: ${m.text}`;
    case "kick": return `${m.text}님이 내보내졌습니다`;
    case "host": return `${m.text}님이 호스트가 되었습니다`;
    case "stamp": return `${m.text}님이 ${clock(m.mediaPositionMs ?? 0)}에 스탬프를 찍었습니다`;
    default: return "";
  }
}
