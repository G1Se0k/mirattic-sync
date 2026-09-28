import { expect, it } from "vitest";
import type { RoomContent, RoomView } from "@mirattic/types";
import { roomToInvite } from "./Home";

const content = (provider: RoomContent["provider"], contentId: string): RoomContent => ({ provider, contentId, title: contentId });
const room = (id: string, c: RoomContent, hostId: string): RoomView => ({
  id, content: c, createdAt: 0,
  members: [{ user: { id: hostId, displayName: hostId }, role: "HOST", present: true }],
});

const video = content("youtube", "dQw4w9WgXcQ");
const rooms = [
  room("mock", content("mock", "mock-1"), "me"),
  room("theirs", video, "friend"),
  room("mine", video, "me"),
  room("other-video", content("youtube", "9bZkp7q19f0"), "me"),
];

it("invites into my room showing what I watch, never one showing something else", () => {
  expect(roomToInvite(rooms, "me", null, video)?.id).toBe("mine");
  expect(roomToInvite(rooms, "me", "mock", video)?.id).toBe("mine"); // the open mock room doesn't win
  expect(roomToInvite(rooms, "me", null, content("youtube", "OPf0YbXqDm0"))).toBeUndefined(); // → new room
});

it("without anything being watched (desktop), prefers the open room I host", () => {
  expect(roomToInvite(rooms, "me", "other-video", null)?.id).toBe("other-video");
  expect(roomToInvite(rooms, "me", "theirs", null)?.id).toBe("mock");
});
