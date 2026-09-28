import { expect, it } from "vitest";
import type { ChatMessage } from "@mirattic/types";
import { group, merge } from "./Chat";

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
