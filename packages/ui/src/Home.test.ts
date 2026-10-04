import { expect, it } from "vitest";
import type { RoomContent, RoomView } from "@mirattic/types";
import { roomToInvite } from "@mirattic/types";
import { applyRequestChanges, describe as lines, refetchFor } from "./Home";
import { latest } from "./format";

const content = (provider: RoomContent["provider"], contentId: string): RoomContent => ({ provider, contentId, title: contentId });
const room = (id: string, c: RoomContent, hostId: string): RoomView => ({
  id, content: c, createdAt: 0,
  members: [{ user: { id: hostId, displayName: hostId }, role: "HOST", present: true }],
});

const video = content("youtube", "dQw4w9WgXcQ");
const rooms = [
  room("laftel", content("laftel", "1/1"), "me"),
  room("theirs", video, "friend"),
  room("mine", video, "me"),
  room("other-video", content("youtube", "9bZkp7q19f0"), "me"),
];

it("invites into my room showing what I watch, never one showing something else", () => {
  expect(roomToInvite(rooms, "me", null, video)?.id).toBe("mine");
  expect(roomToInvite(rooms, "me", "laftel", video)?.id).toBe("mine"); // the open Laftel room doesn't win
  expect(roomToInvite(rooms, "me", null, content("youtube", "OPf0YbXqDm0"))).toBeUndefined(); // → new room
});

it("without anything being watched, prefers the open room I host", () => {
  expect(roomToInvite(rooms, "me", "other-video", null)?.id).toBe("other-video");
  expect(roomToInvite(rooms, "me", "theirs", null)?.id).toBe("laftel");
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

it("shows a YouTube friend's site and channel above the title, and a Netflix friend's episode below it", () => {
  const media = { title: "킹덤", playing: true, capturedAt: 0 };
  expect(lines({ status: "WATCHING", media: { ...media, provider: "youtube", channel: "채널" } }))
    .toEqual(["YouTube · 채널", "킹덤"]);
  expect(lines({ status: "WATCHING", media: { ...media, provider: "youtube", positionMs: 83_000 } }))
    .toEqual(["YouTube", "킹덤"]); // no channel known: the site alone; no position
  expect(lines({ status: "WATCHING", media: { ...media, provider: "laftel", episode: 12, positionMs: 83_000 } }))
    .toEqual(["Laftel · 킹덤", "12화"]); // no position for any site
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix", season: 1, episode: 3 } }))
    .toEqual(["Netflix · 킹덤", "3화"]);
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix", season: 2, episode: 3 } })[1]).toBe("시즌 2 3화");
  expect(lines({ status: "WATCHING", media: { ...media, provider: "netflix" } })[1]).toBe(""); // a film: an empty line
  expect(lines({ status: "WATCHING", media: { ...media, provider: "laftel", episode: 12 } })).toEqual(["Laftel · 킹덤", "12화"]);
});

it("keeps a listed watch request when another comes live while the list loads, and drops one closed meanwhile", () => {
  const a = { id: "a", displayName: "A" }, b = { id: "b", displayName: "B" }, c = { id: "c", displayName: "C" };
  const fetched = [a, c]; // read before b came and c was cancelled
  const after = applyRequestChanges(fetched, [{ n: 1, user: b, open: true }, { n: 2, user: { id: "c", displayName: "" }, open: false }]);
  expect(after.map((u) => u.id)).toEqual(["a", "b"]);
  expect(applyRequestChanges([a], [{ n: 3, user: a, open: true }])).toEqual([a]); // no duplicate
});

it("reads only the rooms and invitations again for a room change, everything for a friend change", () => {
  expect(refetchFor("room:update")).toBe("rooms");
  expect(refetchFor("room:invite")).toBe("rooms");
  expect(refetchFor("friend:update")).toBe("all");
  for (const type of ["chat:message", "watch:request", "presence:update"]) expect(refetchFor(type)).toBeNull();
});

it("invites into a matching room with space before a full one, the full one only if all are", () => {
  const full = (id: string) => ({ ...room(id, video, "me"), memberLimit: 2,
    members: [{ user: { id: "me", displayName: "me" }, role: "HOST" as const, present: true }, { user: { id: "x", displayName: "x" }, role: "MEMBER" as const, present: true }] });
  const spare = room("spare", video, "me");
  expect(roomToInvite([full("open"), spare], "me", "open", video)?.id).toBe("spare"); // the open one is full
  expect(roomToInvite([full("open"), full("other")], "me", "open", video)?.id).toBe("open"); // all full: as before
});
