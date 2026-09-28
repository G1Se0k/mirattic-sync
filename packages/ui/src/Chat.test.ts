import { expect, it } from "vitest";
import type { ChatMessage } from "@mirattic/types";
import { group, merge, receive, reconcile, tombstone, without } from "./Chat";

const msg = (id: string, createdAt: number): ChatMessage => ({ id, roomId: "r", userId: "u", text: id, reaction: false, createdAt });
const react = (id: string, userId: string, emoji: string, mediaPositionMs?: number, createdAt = 0): ChatMessage =>
  ({ id, roomId: "r", userId, text: emoji, mediaPositionMs, reaction: true, createdAt });
const runs = (messages: ChatMessage[]) => group(messages).map((i) => ("userIds" in i ? `${i.emoji}${i.userIds.join("")}` : i.id));

it("keeps live messages that arrived before the history, without duplicates, oldest first", () => {
  const live = [msg("c", 30), msg("b", 20)];
  const history = [msg("a", 10), msg("b", 20)];
  expect(merge(history, live).map((m) => m.id)).toEqual(["a", "b", "c"]);
});

it("orders messages of the same millisecond by id, as the server pages them", () => {
  expect(merge([msg("b", 10)], [msg("a", 10)]).map((m) => m.id)).toEqual(["a", "b"]);
});

it("groups back-to-back reactions with the same emoji at about the same moment", () => {
  const shown = group([
    react("1", "a", "😂", 60_000),
    react("2", "b", "😂", 65_000),
    react("3", "c", "😂", 75_000), // too far from the run's first
    react("4", "a", "🔥", 75_000),
    msg("m", 0),
    react("5", "b", "🔥", 75_000), // a message in between starts a new run
  ]);
  expect(shown.map((i) => ("userIds" in i ? `${i.emoji}${i.userIds.join("")}` : i.id))).toEqual(["😂ab", "😂c", "🔥a", "m", "🔥b"]);
});

it("does not group reactions sent far apart, even at the same (paused) position", () => {
  expect(runs([react("1", "a", "❤️", 60_000, 0), react("2", "b", "❤️", 60_000, 60_000)])).toEqual(["❤️a", "❤️b"]);
  expect(runs([react("1", "a", "❤️", 60_000, 0), react("2", "b", "❤️", 60_000, 9_000)])).toEqual(["❤️ab"]);
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
  expect(group([{ ...msg("r", 1), reaction: true, deleted: true }, msg("m", 2)]).map((i) => i.id)).toEqual(["m"]);
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
