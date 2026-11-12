import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Socket, SocketStatus } from "@mirattic/client";
import type { ChatDeleted, ChatMessage, RoomMemberView, ServerEvent } from "@mirattic/types";
import { api } from "./session";
import { clock, parseClock } from "./format";
import { Avatar, IconButton } from "./Icons";
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
  /** This browser shows the room's video: stamping is offered (a dialog open when it stops closes). */
  canStamp: boolean;
  /** Its length, where known: a stamp past it isn't sent. */
  videoMs?: number;
  /**
   * A member's box, opened from their name on a message or log line; `done` closes it. `gone`: no longer in the room
   * (left, kicked) — only what it knows of them from that line.
   */
  memberBox: (member: RoomMemberView, done: () => void, gone: boolean) => ReactNode;
  /** "@ 언급" pressed (a new `n` each time): `@name ` added to what is being written, the input focused. */
  mention?: { name: string; n: number };
};

const PAGE = 100; // the server's page size: a full page means there may be more
const NEAR_BOTTOM_PX = 40;
const FLASH_MS = 1600;
const STAMP_WAIT_MS = 5000;

export function Chat({ roomId, meId, members, isHost, socket, status, subscribe, position, onSeek, video, canStamp, videoMs, memberBox, mention }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const shownLines = useMemo(() => messages.filter(visible), [messages]);
  /** A mention that opens `id`'s box (a member's, or one gone from the room: as theirs on a line). */
  const mentionLink = (item: ChatMessage, id: string, shown: string, at: string) => (
    <button key={at} type="button" className={`mention${isPicked(item.id, at) ? " on" : ""}`} aria-haspopup="dialog"
      aria-expanded={isPicked(item.id, at)} data-anchor={at} onClick={() => openBox(item.id, id, at, shown)}>
      @{shown}
    </button>
  );
  /**
   * A message's text with its mentions: those kept by ID where the server says they are (decision 122), each its
   * own; an older message's (kept as written) by the members' names now, only one whose name is theirs alone.
   */
  const withMentionsOf = (item: ChatMessage): ReactNode => {
    if (item.mentionSpans?.length) {
      // The host's "@everyone" (server-marked) found in the whole text, as a word of its own there, outside the spans.
      const spans = item.mentionSpans;
      const everyone = item.mentions?.includes(EVERYONE)
        ? [...item.text.matchAll(mentionRe([EVERYONE], "gu"))].map((m) => ({ id: null, start: m.index, end: m.index + m[0].length }))
          .filter((e) => !spans.some((s) => e.start < s.end && s.start < e.end))
        : [];
      const out: ReactNode[] = [];
      let from = 0;
      [...spans, ...everyone].sort((a, b) => a.start - b.start).forEach((s, i) => {
        out.push(item.text.slice(from, s.start));
        const shown = item.text.slice(s.start + 1, s.end);
        out.push(s.id ? mentionLink(item, s.id, shown, `m${i}`) : <strong key={`e${i}`} className="mention">@{shown}</strong>);
        from = s.end;
      });
      out.push(item.text.slice(from));
      return out;
    }
    const nameOf = (id: string) => members.find((x) => x.user.id === id)?.user.displayName;
    return withMentions(item.text, [
      ...(item.mentions ?? []).flatMap((id) => {
        const n = id === EVERYONE ? undefined : nameOf(id);
        return n ? [n] : [];
      }),
      ...(item.mentions?.includes(EVERYONE) ? [EVERYONE] : []),
    ], (shown, i) => {
      // Not the host's @everyone (a member named "everyone" mentioned otherwise is theirs); two of a name: neither.
      const named = shown === EVERYONE && item.mentions?.includes(EVERYONE) ? []
        : (item.mentions ?? []).filter((id) => id !== EVERYONE && nameOf(id) === shown);
      const id = named.length === 1 ? named[0] : undefined;
      return id ? mentionLink(item, id, shown, `m${i}`) : <strong key={i} className="mention">@{shown}</strong>;
    });
  };
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  /** Where the caret is (what "@…" is being typed before it), and the suggestion chosen; closed by Esc until it changes. */
  const [caret, setCaret] = useState(0);
  const suggestId = useId();
  const [pick, setPick] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const typing = mentionTyped(text, caret);
  const choices = typing === null || closedAt === `${caret}:${text}` ? [] : mentionChoices(typing.query, members, meId, isHost);
  const chosen = Math.min(pick, Math.max(choices.length - 1, 0));
  function complete(name: string) {
    const done = completeMention(text, caret, name);
    if (!done) return;
    const { text: next, caret: at } = done;
    setText(next);
    setCaret(at);
    setPick(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(at, at));
  }
  function onMentionKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!choices.length || e.nativeEvent.isComposing) return; // the IME's keys while composing
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setPick((chosen + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const c = choices[chosen];
      if (c) complete(c.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setClosedAt(`${caret}:${text}`);
    }
  }
  useEffect(() => {
    if (!mention) return;
    // Whole or not at all: a draft without room for it is left as it is (a cut name would name no one).
    setText((t) => {
      const next = `${t}${t && !t.endsWith(" ") ? " " : ""}@${mention.name} `;
      return next.length <= 1000 ? next : t;
    });
    input.current?.focus();
  }, [mention]);
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
  /** Messages mentioning me that came while I was scrolled up, oldest first: the "@ 새 멘션" button goes to each. */
  const [unseenMentions, setUnseenMentions] = useState<string[]>([]);
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
          const msg = event.payload as ChatMessage;
          if (event.type === "chat:message" && !atBottom.current && msg.userId !== meId && msg.mentions?.includes(meId)) {
            setUnseenMentions((ids) => (ids.includes(id) ? ids : [...ids, id]));
          }
          setFresh((ids) => new Set(ids).add(id));
          setTimeout(() => setFresh((ids) => new Set([...ids].filter((x) => x !== id))), FLASH_MS);
        }
      }),
    [roomId, subscribe, meId],
  );
  useEffect(() => () => clearTimeout(stampWait.current?.timer), []);
  // The video went away (no tab, no video, another one): the dialog closes; a stamp already sent counts as failed here
  // (its late answer is ignored — the server, which doesn't know what this browser shows, may still post it).
  useEffect(() => {
    if (canStamp || stamping === null) return;
    const sent = !!stampWait.current;
    closeStamp();
    if (sent) setFailed("타임스탬프를 찍지 못했습니다: 인식 중인 영상이 없어졌습니다.");
  }, [canStamp, stamping]);

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

  // The list itself shrinking or growing (the member list folding above, a resize) keeps the bottom in view.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const keep = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    return () => keep.disconnect();
  }, []);

  function onScroll() {
    const el = list.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current) {
      setUnseen(false);
      setUnseenMentions([]);
    }
  }
  /** To the oldest mention not yet gone to (one deleted or no longer loaded is skipped). */
  function toMention() {
    const ids = [...unseenMentions];
    let line: HTMLElement | null | undefined = null;
    while (ids.length && !line) line = list.current?.querySelector<HTMLElement>(`[data-line="${ids.shift()}"]`);
    setUnseenMentions(ids);
    line?.scrollIntoView({ block: "center" });
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
    const mentions = mentionsIn(trimmed, members.map((m) => m.user), meId, isHost);
    if (socket.send({ type: "chat:message", roomId, payload: { text: trimmed, mediaPositionMs: await position(), contentKey: video,
      ...(mentions.length ? { mentions } : {}) } })) setText("");
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

  // A name's box (the message it was opened on, and the name there: its author or an "@name" in it): floats under the
  // name, or over it without room below in view. It sits in the list, so it scrolls with its line; it closes as the
  // members' does, and when that member leaves.
  const [picked, setPicked] = useState<{ line: string; userId: string; at: string; name: string } | null>(null);
  const openBox = (line: string, userId: string, at: string, name: string) =>
    setPicked((p) => (p?.line === line && p.at === at ? null : { line, userId, at, name }));
  const isPicked = (line: string, at: string) => picked?.line === line && picked.at === at;
  const box = useRef<HTMLLIElement>(null);
  const inRoom = picked && members.find((m) => m.user.id === picked.userId);
  // One no longer in the room: the name the line has (decision 120).
  const pickedMember: RoomMemberView | null = inRoom
    ?? (picked && { user: { id: picked.userId, displayName: picked.name }, role: "MEMBER", present: false });
  const nameOf = () => list.current?.querySelector<HTMLElement>(`[data-line="${picked?.line}"] [data-anchor="${picked?.at}"]`);
  useLayoutEffect(() => {
    const nick = nameOf();
    const el = box.current;
    const ul = list.current;
    if (!nick || !el || !ul) return;
    const n = nick.getBoundingClientRect();
    const u = ul.getBoundingClientRect();
    // Under the name if it fits in view, else over it if that fits, else the side with more room — then kept in view
    // (a short chat: from its top, scrolling inside when taller than the chat).
    el.style.maxHeight = `${ul.clientHeight}px`;
    const h = el.offsetHeight;
    const fitsBelow = n.bottom + 4 + h <= u.bottom;
    const below = fitsBelow || (n.top - 4 - h < u.top && u.bottom - n.bottom > n.top - u.top);
    const top = (below ? n.bottom + 4 : n.top - 4 - h) - u.top + ul.scrollTop;
    el.style.top = `${Math.max(ul.scrollTop, Math.min(top, ul.scrollTop + ul.clientHeight - h))}px`;
    el.style.left = `${Math.max(0, Math.min(n.left - u.left - 6, ul.clientWidth - el.offsetWidth))}px`;
  });
  useEffect(() => {
    if (picked && !nameOf()) setPicked(null); // the name it opened from is gone (deleted, or no longer loaded)
  });
  useEffect(() => {
    if (!picked) return;
    box.current?.focus({ preventScroll: true });
  }, [picked]);
  const closeBox = () => {
    nameOf()?.focus();
    setPicked(null);
  };
  useEffect(() => {
    if (!picked) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") closeBox();
      } else if (!box.current?.contains(e.target as Node) && !nameOf()?.contains(e.target as Node)) setPicked(null);
    };
    const shut = () => setPicked(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", shut);
    };
  }, [picked]);

  // A member's name now; one who left: the name the message came with (decision 112), "나간 사용자" without one.
  const name = (id: string, sent?: string | null) => {
    const member = members.find((m) => m.user.id === id)?.user.displayName;
    if (id === meId) return `${member ?? sent ?? "나"}(나)`;
    return member ?? sent ?? "나간 사용자";
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
            <li key={item.id} className={`log${fresh.has(item.id) ? " fresh" : ""}`} data-line={item.id}>
              {item.kind === "content" ? logText(item) : (
                // The name on it (join, leave, kick, host, stamp: the line's userId is theirs) opens their box.
                <>
                  <button type="button" className={`author${isPicked(item.id, "log") ? " on" : ""}`} aria-haspopup="dialog"
                    aria-expanded={isPicked(item.id, "log")} data-anchor="log" onClick={() => openBox(item.id, item.userId, "log", item.text)}>
                    {item.text}
                  </button>
                  {item.kind === "stamp" && item.mediaPositionMs !== undefined
                    ? <>님이 {timestamp(item.mediaPositionMs, item.contentKey)}에 스탬프를 찍었습니다</>
                    : logText(item).slice(item.text.length)}
                </>
              )}
            </li>
          ) : (
            <li key={item.id} className={`row${fresh.has(item.id) ? " fresh" : ""}${item.mentions?.includes(meId) ? " mentioned" : ""}`}
              data-line={item.id}>
              <span className="grow">
                <button type="button" className={`author${isPicked(item.id, "author") ? " on" : ""}`} aria-haspopup="dialog"
                  aria-expanded={isPicked(item.id, "author")} data-anchor="author"
                  onClick={() => openBox(item.id, item.userId, "author", name(item.userId, item.userName))}>
                  {name(item.userId, item.userName)}
                </button>
                {item.deleted ? (
                  <span className="deleted">삭제된 메시지입니다</span>
                ) : (
                  <>
                    {timestamp(item.mediaPositionMs, item.contentKey)}
                    <span className="message">{withMentionsOf(item)}</span>
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
        {pickedMember && (
          <li className="member-box" ref={box} tabIndex={-1} role="dialog" aria-label={`${pickedMember.user.displayName} 메뉴`}>
            {memberBox(pickedMember, closeBox, !inRoom)}
          </li>
        )}
      </ul>
      {unseenMentions.length > 0 ? (
        <button className="mention-jump" onClick={toMention}><b aria-hidden="true">@</b> 새 멘션 {unseenMentions.length}개</button>
      ) : unseen && (
        <button className="link" onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight })}>새 메시지 ↓</button>
      )}
      <div className="composer">
        {failed && <p className="error" role="alert">{failed}</p>}
        <form onSubmit={send}>
          {choices.length > 0 && (
            <ul id={suggestId} className="mention-suggest" role="listbox" aria-label="언급할 사람">
              {choices.map((c, i) => (
                <li key={c.id} id={`${suggestId}-${i}`} role="option" aria-selected={i === chosen} className={i === chosen ? "on" : undefined}
                  onMouseDown={(e) => { e.preventDefault(); complete(c.name); }} onMouseEnter={() => setPick(i)}>
                  {c.id === EVERYONE ? <span className="everyone" aria-hidden="true">@</span> : <Avatar name={c.name} src={c.avatarUrl} />}
                  {c.name}
                  {c.sub && <span className="sub">{c.sub}</span>}
                </li>
              ))}
            </ul>
          )}
          <input ref={input} placeholder="메시지" maxLength={1000} value={text} role="combobox" aria-expanded={choices.length > 0}
            aria-autocomplete="list" aria-controls={choices.length ? suggestId : undefined}
            aria-activedescendant={choices.length ? `${suggestId}-${chosen}` : undefined} onKeyDown={onMentionKey}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setPick(0); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onBlur={() => setClosedAt(`${caret}:${text}`)}
            onFocus={() => setClosedAt(null)} />
          <IconButton icon="clock" label="타임스탬프 찍기" disabled={status !== "open" || !video || !canStamp} onClick={() => void openStamp()} />
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
    .map((m) => (deleted.some((d) => d.id === m.id) && !m.deleted ? { ...m, text: "", mediaPositionMs: undefined, mentions: null, deleted: true } : m));
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "@name" as a whole word: not "@민수" inside "@민수2", nor after a letter ("x@everyone.com"). */
const mentionRe = (names: string[], flags = "u") =>
  new RegExp(`(?<![\\p{L}\\p{N}_])@(${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, flags);

/** The host's mention of every member (decision 118). */
export const EVERYONE = "everyone";

/** The other members a message names with "@name" (decision 118), each once — all of them for the host's "@everyone". */
export function mentionsIn(text: string, users: { id: string; displayName: string }[], meId: string, isHost = false): string[] {
  if (isHost && mentionRe([EVERYONE]).test(text)) return users.filter((u) => u.id !== meId).map((u) => u.id);
  return users.filter((u) => u.id !== meId && u.displayName && mentionRe([u.displayName]).test(text)).map((u) => u.id);
}

/** An "@…" being typed right before the caret (at the start or after a space): where its "@" is, and what follows. */
export function mentionTyped(text: string, caret: number): { at: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
  const query = m?.[1];
  return query === undefined ? null : { at: caret - query.length - 1, query };
}

/**
 * "@name " in place of the "@…" at the caret — the whole of it, also what follows the caret up to a space — and the
 * caret after it; null if there is none, or past 1000 characters (a cut name would name no one).
 */
export function completeMention(text: string, caret: number, name: string): { text: string; caret: number } | null {
  const typed = mentionTyped(text, caret);
  if (!typed) return null;
  const end = caret + (/^[^\s@]*/u.exec(text.slice(caret))?.[0].length ?? 0);
  const next = `${text.slice(0, typed.at)}@${name} ${text.slice(end).replace(/^ /, "")}`;
  return next.length > 1000 ? null : { text: next, caret: typed.at + name.length + 2 };
}

/** Whom "@query" may name: the other members whose name has it (those starting with it first), "everyone" for the host. */
export function mentionChoices(query: string, members: RoomMemberView[], meId: string, isHost: boolean) {
  const q = query.toLocaleLowerCase();
  const people = members
    .filter((m) => m.user.id !== meId && m.user.displayName.toLocaleLowerCase().includes(q))
    .sort((a, b) => Number(!a.user.displayName.toLocaleLowerCase().startsWith(q)) - Number(!b.user.displayName.toLocaleLowerCase().startsWith(q)))
    .map((m) => ({ id: m.user.id, name: m.user.displayName, avatarUrl: m.user.avatarUrl, sub: m.role === "HOST" ? "호스트" : undefined }));
  const all = isHost && EVERYONE.startsWith(q) && members.some((m) => m.user.id !== meId)
    ? [{ id: EVERYONE, name: EVERYONE, avatarUrl: undefined, sub: "방 멤버 모두" }] : [];
  return [...all, ...people].slice(0, 6);
}

/** The text with each "@name" of these (the mentioned members') shown by `show` (its name, its index in the parts). */
export function withMentions(text: string, names: string[],
  show: (name: string, i: number) => ReactNode = (name, i) => <strong key={i} className="mention">@{name}</strong>): ReactNode {
  if (!names.length) return text;
  const parts = text.split(mentionRe([...names].sort((a, b) => b.length - a.length), "gu"));
  // split with one group: the names at odd places
  return parts.map((part, i) => (i % 2 ? show(part, i) : part));
}
