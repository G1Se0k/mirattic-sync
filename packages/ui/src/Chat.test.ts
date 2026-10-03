import { expect, it } from "vitest";
import type { ChatMessage } from "@mirattic/types";
import { logText, merge, receive, reconcile, tombstone, visible, without } from "./Chat";
import { parseClock } from "./format";

const msg = (id: string, createdAt: number): ChatMessage => ({ id, roomId: "r", userId: "u", text: id, createdAt });

it("keeps live messages that arrived before the history, without duplicates, oldest first", () => {
  const live = [msg("c", 30), msg("b", 20)];
  const history = [msg("a", 10), msg("b", 20)];
  expect(merge(history, live).map((m) => m.id)).toEqual(["a", "b", "c"]);
});

it("orders messages of the same millisecond by id, as the server pages them", () => {
  expect(merge([msg("b", 10)], [msg("a", 10)]).map((m) => m.id)).toEqual(["a", "b"]);
});

it("shows room logs", () => {
  const seek = { ...msg("s", 2), text: "", kind: "seek" as const, mediaPositionMs: 60_000 };
  const list = receive([msg("a", 1)], [], { type: "chat:log", roomId: "r", serverTime: 0, payload: seek });
  expect(list.map((m) => [m.id, m.kind ?? null])).toEqual([["a", null], ["s", "seek"]]);
  expect(logText({ ...msg("j", 1), text: "민수", kind: "join" })).toBe("민수님이 들어왔습니다");
  expect(logText({ ...msg("c", 1), text: "2화", kind: "content" })).toBe("호스트가 영상을 바꿨습니다: 2화");
  expect(logText({ ...msg("s", 1), text: "", kind: "seek", mediaPositionMs: 754_000 })).toBe("호스트가 12:34로 이동했습니다");
  expect(logText({ ...msg("k", 1), text: "민수", kind: "kick" })).toBe("민수님이 내보내졌습니다");
  expect(logText({ ...msg("t", 1), text: "민수", kind: "stamp", mediaPositionMs: 65_000 })).toBe("민수님이 1:05에 스탬프를 찍었습니다");
});

it("drops a deleted message, or every message of a deleted account", () => {
  const list = [msg("a", 1), { ...msg("b", 2), userId: "gone" }, msg("c", 3)];
  expect(without(list, [{ id: "a" }]).map((m) => m.id)).toEqual(["b", "c"]);
  expect(without(list, [{ userId: "gone" }]).map((m) => m.id)).toEqual(["a", "c"]);
});

it("after a reconnect, drops shown messages deleted meanwhile but keeps older pages and newer arrivals", () => {
  const page = Array.from({ length: 100 }, (_, i) => msg(`p${i}`, 100 + i));
  const shown = [msg("older", 50), msg("p0", 100), msg("deleted", 150), msg("newer", 300)];
  expect(reconcile(page, shown).map((m) => m.id)).toEqual(["older", ...page.map((m) => m.id), "newer"]);
  // A short page is the whole history: anything older missing from it was deleted too.
  expect(reconcile([msg("a", 10)], [msg("gone", 5), msg("a", 10), msg("new", 20)]).map((m) => m.id)).toEqual(["a", "new"]);
});

it("shows a deleted message as a placeholder, and drops a deleted account's messages", () => {
  const list = [msg("a", 1), { ...msg("b", 2), userId: "gone" }, msg("c", 3)];
  expect(tombstone(list, [{ id: "a" }]).map((m) => [m.id, m.text, !!m.deleted])).toEqual([["a", "", true], ["b", "b", false], ["c", "c", false]]);
  expect(tombstone(list, [{ userId: "gone" }]).map((m) => m.id)).toEqual(["a", "c"]);
});

it("a message overtaken by its deletion (or its author's account deletion) stays deleted when it arrives", () => {
  const deleted: { id?: string; userId?: string }[] = [];
  const event = (type: string, payload: unknown) => ({ type, roomId: "r", serverTime: 0, payload });
  let list = receive([msg("a", 1)], deleted, event("chat:delete", { id: "late" }));
  list = receive(list, deleted, event("chat:message", msg("late", 2)));
  expect(list.map((m) => [m.id, !!m.deleted])).toEqual([["a", false], ["late", true]]);
  list = receive(list, deleted, event("chat:delete", { userId: "gone" }));
  list = receive(list, deleted, event("chat:message", { ...msg("b", 3), userId: "gone" }));
  list = receive(list, deleted, event("chat:message", msg("c", 4)));
  expect(list.map((m) => m.id)).toEqual(["a", "late", "c"]);
});

it("after a reconnect, a message deleted meanwhile shows the server's placeholder, not the old text", () => {
  const page = [msg("a", 1), { ...msg("b", 2), text: "", deleted: true }];
  const shown = [msg("a", 1), msg("b", 2)];
  expect(reconcile(page, shown).map((m) => [m.id, m.text, !!m.deleted])).toEqual([["a", "a", false], ["b", "", true]]);
});

it("a stamp's time as typed", () => {
  expect(parseClock("3:28")).toBe(208_000);
  expect(parseClock(" 1:02:03 ")).toBe(3_723_000);
  expect(parseClock("0:00")).toBe(0);
  for (const bad of ["", "3", "3:7", "3:60", "1:60:00", "a:bc", "-1:00", "1:02:03:04"]) expect(parseClock(bad)).toBeNull();
});

it("the host's playback lines aren't shown; the rest are", () => {
  for (const kind of ["play", "pause", "seek"] as const) expect(visible({ ...msg("p", 1), kind })).toBe(false);
  for (const kind of [null, "join", "content", "stamp"] as const) expect(visible({ ...msg("o", 1), kind })).toBe(true);
});
