import { expect, it } from "vitest";
import type { ChatMessage } from "@mirattic/types";
import { merge } from "./Chat";

const msg = (id: string, createdAt: number): ChatMessage => ({ id, roomId: "r", userId: "u", text: id, createdAt });

it("keeps live messages that arrived before the history, without duplicates, oldest first", () => {
  const live = [msg("c", 30), msg("b", 20)];
  const history = [msg("a", 10), msg("b", 20)];
  expect(merge(history, live).map((m) => m.id)).toEqual(["a", "b", "c"]);
});
