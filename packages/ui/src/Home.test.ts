import { expect, it } from "vitest";
import type { ChatMessage, RoomContent, RoomView } from "@mirattic/types";
import { describe as lines, roomToInvite, settleUnlisted } from "./Home";
import { latest } from "./format";

const content = (provider: RoomContent["provider"], contentId: string): RoomContent => ({ provider, contentId, title: contentId });
const room = (id: string, c: RoomContent, hostId: string): RoomView => ({
  id, content: c, createdAt: 0, unread: 0, muted: false,
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

it("drops a room list that was requested before a newer load or a local count change", async () => {
  const loads = latest();
  let rooms = "start";
  const load = (value: string, delay: number) => {
    const current = loads.begin();
    return new Promise((r) => setTimeout(r, delay)).then(() => void (current() && (rooms = value)));
  };
  const slow = load("stale", 20); // read unread = 0 on the server …
  loads.invalidate(); // … then a message arrived and the badge went to 1
  await slow;
  expect(rooms).toBe("start");

  const older = load("older", 20);
  const newer = load("newer", 0);
  await Promise.all([older, newer]);
  expect(rooms).toBe("newer");
});

it("keeps a message whose room a list doesn't show yet, and notifies it once a later list shows it", () => {
  const first: ChatMessage = { id: "m1", roomId: "new", userId: "friend", text: "hi", createdAt: 0 };
  const before = settleUnlisted([first], rooms, null); // a list read before the invite
  expect(before.listed).toEqual([]);
  expect(before.waiting).toEqual([first]);

  const invited = room("new", video, "friend");
  const after = settleUnlisted(before.waiting, [...rooms, invited], null);
  expect(after.listed).toEqual([[invited, first]]);
  expect(after.waiting).toEqual([]);
  expect(settleUnlisted([first], [invited], "new").listed).toEqual([]); // open: the room shows it
});

it("shows a YouTube friend's channel above the title, and a Netflix friend's episode below it", () => {
  const media = { title: "킹덤", playing: true, capturedAt: 0 };
  expect(lines({ status: "WATCHING", media: { ...media, provider: "youtube", channel: "채널" } }))
    .toEqual(["채널", "YouTube · 킹덤 시청 중"]);
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix", season: 1, episode: 3 } }))
    .toEqual(["Netflix · 킹덤 시청 중", "3화"]);
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix", season: 2, episode: 3 } })[1]).toBe("시즌 2 3화");
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix" } })[1]).toBe(""); // a film: an empty line
  expect(lines({ status: "WATCHING", media: { ...media, provider: "laftel", episode: 12 } })).toEqual(["Laftel · 킹덤 시청 중", "12화"]);
});
