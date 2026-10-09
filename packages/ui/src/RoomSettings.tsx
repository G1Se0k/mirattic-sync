import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@mirattic/client";
import { MAX_MEMBERS, MAX_ROOM_NAME, MIN_MEMBERS, type PublicRoom, type RoomSettings } from "@mirattic/types";
import { api } from "./session";
import { Actions, Dialog } from "./Dialog";
import { IconButton, ProviderIcon } from "./Icons";

/**
 * A room's name, member limit and public setting (decisions 109–110): asked before a room is made ("방 만들기") and
 * changed by its host ("방 설정"). `min`: the members already in (the limit can't go below). `onSave` rejecting keeps
 * the dialog open with its error.
 */
export function RoomSettingsDialog({ title, ok, initial, placeholder, min = 1, onSave, onClose }: {
  title: string;
  ok: string;
  initial: RoomSettings;
  /** What shows without a name (the video's title). */
  placeholder: string;
  min?: number;
  onSave: (settings: RoomSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [limit, setLimit] = useState(initial.memberLimit);
  const [isPublic, setPublic] = useState(initial.isPublic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lowest = Math.max(MIN_MEMBERS, min);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), memberLimit: limit, isPublic });
    } catch (err) {
      setError(err instanceof ApiError && err.message === "limit below members"
        ? "지금 들어와 있는 인원보다 적게 줄일 수 없습니다." : "실패했습니다. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Not closed while saving: a room being made would still open, after the dialog said it wouldn't.
    <Dialog title={title} onClose={busy ? undefined : onClose}>
      <form className="stack room-settings" onSubmit={submit}>
        <label className="stack field">
          <span>방 제목</span>
          <input value={name} maxLength={MAX_ROOM_NAME} placeholder={placeholder} autoFocus
            onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row field">
          <span className="grow">
            최대 인원
            <span className="muted">호스트 포함 {MIN_MEMBERS}~{MAX_MEMBERS}명{min > MIN_MEMBERS && ` · 지금 ${min}명`}</span>
          </span>
          <span className="stepper">
            <button type="button" aria-label="인원 줄이기" disabled={limit <= lowest} onClick={() => setLimit(limit - 1)}>−</button>
            <output aria-live="polite">{limit}명</output>
            <button type="button" aria-label="인원 늘리기" disabled={limit >= MAX_MEMBERS} onClick={() => setLimit(limit + 1)}>+</button>
          </span>
        </div>
        <div className="stack field" role="radiogroup" aria-label="공개 설정">
          <span>공개 설정</span>
          <label className="option">
            <input type="radio" name="room-public" checked={!isPublic} onChange={() => setPublic(false)} />
            <span>비공개<span className="muted">초대받은 친구와 방 코드를 아는 사람만 들어옵니다.</span></span>
          </label>
          <label className="option">
            <input type="radio" name="room-public" checked={isPublic} onChange={() => setPublic(true)} />
            <span>공개<span className="muted">공개 방 목록에 보여 누구나 들어올 수 있습니다. 방 제목 · 영상 제목 · 호스트 이름 · 인원이 모든 사용자에게 보입니다.</span></span>
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <Actions>
          <button type="button" className="link" disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" disabled={busy}>{ok}</button>
        </Actions>
      </form>
    </Dialog>
  );
}

/**
 * The public rooms (decision 110), searched by name or video title, a page at a time ("더 보기"); the list scrolls.
 * `inRoom`: rooms I'm already in (entered, not joined). Only the latest search's answer shows.
 */
export function PublicRoomsDialog({ inRoom, onJoined, onClose }: {
  inRoom: (id: string) => boolean;
  onJoined: (roomId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const opened = useRef(false);
  /** One join at a time: two clicks would make me a member of both and open whichever answered last. */
  const [joiningId, setJoiningId] = useState<string | null>(null);

  function load(q: string, before?: string) {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    api.publicRooms(q.trim(), before).then((page) => {
      if (mine !== latest.current) return;
      setRooms((shown) => (before ? [...(shown ?? []), ...page.rooms.filter((r) => !shown?.some((s) => s.id === r.id))] : page.rooms));
      setNext(page.next ?? null);
    }, () => mine === latest.current && setError("공개 방을 불러오지 못했습니다.")).finally(() => mine === latest.current && setLoading(false));
  }

  // On open, and 300 ms after typing stops. A changed search drops what was shown and any answer still coming (for
  // the old search) at once: nothing listed is for another search.
  useEffect(() => {
    latest.current++;
    if (opened.current) {
      setRooms(null);
      setNext(null);
      setLoading(true);
    }
    const t = setTimeout(() => load(query), opened.current ? 300 : 0);
    opened.current = true;
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  async function join(room: PublicRoom) {
    if (inRoom(room.id)) return onJoined(room.id);
    setError(null);
    setJoiningId(room.id);
    try {
      onJoined((await api.joinPublicRoom(room.id)).id);
    } catch (e) {
      setJoiningId(null);
      const status = e instanceof ApiError ? e.status : 0;
      // What it said, shown in the list at once (no reload, which would clear the message): full, or gone from it.
      if (status === 409) setRooms((shown) => shown?.map((r) => (r.id === room.id ? { ...r, members: r.memberLimit } : r)) ?? null);
      if (status === 404) setRooms((shown) => shown?.filter((r) => r.id !== room.id) ?? null);
      setError(status === 409 ? "방이 가득 찼습니다." : status === 404 ? "더 이상 공개되지 않은 방입니다." : "들어가지 못했습니다.");
    }
  }

  return (
    <Dialog title={
      <span className="row">
        <span className="grow">공개 방</span>
        <IconButton icon="refresh" label="새로고침" disabled={loading} onClick={() => load(query)} />
      </span>
    } onClose={onClose}>
      <input type="search" placeholder="방 제목 · 영상 제목 검색" value={query} maxLength={100} autoFocus
        aria-label="공개 방 검색" onChange={(e) => setQuery(e.target.value)} />
      <div className="public-rooms">
        {rooms === null && loading && <p className="muted">불러오는 중…</p>}
        {rooms?.length === 0 && !loading && <p className="muted">{query.trim() ? "찾는 방이 없습니다." : "지금 열린 공개 방이 없습니다."}</p>}
        {rooms && rooms.length > 0 && (
          <ul className="list box">
            {rooms.map((r) => {
              const full = r.members >= r.memberLimit && !inRoom(r.id);
              return (
                <li key={r.id} className="item">
                  {r.provider ? <ProviderIcon provider={r.provider} /> : <span className="provider none" title="영상 없음">·</span>}
                  <div className="grow">
                    <div className="name ellipsis">{r.name || r.title || "영상 없음"}</div>
                    {r.name && r.title && <div className="muted ellipsis">{r.title}</div>}
                    <div className="muted ellipsis">{r.hostName}님의 방 · {r.members}/{r.memberLimit}명</div>
                  </div>
                  <button className="small" disabled={full || joiningId !== null} onClick={() => void join(r)}>
                    {joiningId === r.id ? "참가 중…" : inRoom(r.id) ? "입장" : full ? "가득 참" : "참가"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {next !== null && (
          <button className="link" disabled={loading} onClick={() => load(query, next)}>{loading ? "불러오는 중…" : "더 보기"}</button>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted">공개 방에서는 모르는 사람과 함께 봅니다. 불편한 사용자는 신고하거나 차단할 수 있습니다.</p>
      <Actions>
        <button type="button" className="link" onClick={onClose}>닫기</button>
      </Actions>
    </Dialog>
  );
}
