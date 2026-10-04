import { expect, it } from "vitest";
import type { PlayerSnapshot, RoomContent } from "@mirattic/types";
import { showsRoomVideo } from "./Room";

const content: RoomContent = { provider: "youtube", contentId: "12345678901", title: "x" };
const on = (contentId: string): PlayerSnapshot => ({ contentId, positionMs: 0, playing: true, capturedAt: 0 });
const youtube = { canPlay: true, playerProvider: "youtube" as const };

it("says the browser shows the room's video only for its site and id, with a player that read it", () => {
  expect(showsRoomVideo({ ...youtube, snapshot: on("12345678901") }, content)).toBe(true);
  expect(showsRoomVideo({ ...youtube, snapshot: null }, content)).toBe(false); // a tab with no video
  expect(showsRoomVideo({ ...youtube, snapshot: undefined }, content)).toBe(false); // not read yet
  expect(showsRoomVideo({ ...youtube, snapshot: on("9bZkp7q19f0") }, content)).toBe(false); // another video
  // The same id on another site (a Netflix id can look like a YouTube one): not the room's video.
  expect(showsRoomVideo({ canPlay: true, playerProvider: "netflix", snapshot: on("12345678901") }, content)).toBe(false);
  expect(showsRoomVideo({ canPlay: false, playerProvider: null, snapshot: null }, content)).toBe(false); // no player
  expect(showsRoomVideo({ ...youtube, snapshot: on("12345678901") }, null)).toBe(false); // no room video
});
