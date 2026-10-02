package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.ws.RoomLog;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

class RoomFlowTest extends IntegrationTest {

	private static final String CONTENT = """
			{"provider":"mock","contentId":"c1","title":"Fake","durationMs":600000}""";

	@Test
	void onlyFriendsCanBeInvitedAndRoomsAreHiddenFromOthers() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		Client friendWs = connect(friend);

		createRoom(host, stranger).andExpect(status().isBadRequest());
		JsonNode room = body(createRoom(host, friend).andExpect(status().isOk()));
		String roomId = room.path("id").asString();
		assertThat(room.path("members")).hasSize(2);

		JsonNode invite = friendWs.nextOfType("room:invite");
		assertThat(invite.path("roomId").asString()).isEqualTo(roomId);
		assertThat(body(call(HttpMethod.GET, "/api/rooms", friend.accessToken(), null))).hasSize(1);
		assertThat(body(call(HttpMethod.GET, "/api/rooms", stranger.accessToken(), null))).isEmpty();
		call(HttpMethod.GET, "/api/rooms/" + roomId, stranger.accessToken(), null).andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"mock","contentId":"c1","title":"x","canonicalUrl":"http://a"},"inviteIds":[]}""")
				.andExpect(status().isBadRequest());
	}

	@Test
	void onlyMembersJoinAndOnlyTheHostControlsPlayback() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();

		Client strangerWs = connect(stranger);
		strangerWs.send(event("room:join", roomId, "{}"));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_member");
		strangerWs.send(event("playback:play", roomId, "{\"positionMs\":0,\"capturedAt\":0}"));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_member");

		Client friendWs = connect(friend);
		friendWs.send(event("playback:play", roomId, "{\"positionMs\":0,\"capturedAt\":0}"));
		assertThat(friendWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_host");
	}

	@Test
	void hostCommandsReachJoinedMembersWithIncreasingVersions() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();

		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		JsonNode initial = friendWs.nextOfType("playback:update");
		assertThat(initial.path("version").asLong()).isZero();
		assertThat(initial.path("payload").path("playing").asBoolean()).isFalse();

		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		assertThat(hostWs.nextOfType("room:update")).isNotNull(); // sent after the host's join is recorded
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + roomId, friend.accessToken(), null))
				.path("members").findValues("present")).allMatch(JsonNode::asBoolean);

		long now = System.currentTimeMillis();
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":1000,\"capturedAt\":%d}".formatted(now)));
		JsonNode play = friendWs.nextOfType("playback:update");
		assertThat(play.path("version").asLong()).isEqualTo(1);
		assertThat(play.path("userId").asString()).isEqualTo(host.id());
		assertThat(play.path("payload").path("playing").asBoolean()).isTrue();
		assertThat(play.path("payload").path("capturedAt").asLong()).isEqualTo(now);

		// A capture time far in the past is replaced by the server's receive time.
		hostWs.send(event("playback:seek", roomId, "{\"positionMs\":900000,\"capturedAt\":1}"));
		JsonNode seek = friendWs.nextOfType("playback:update");
		assertThat(seek.path("version").asLong()).isEqualTo(2);
		assertThat(seek.path("payload").path("playing").asBoolean()).isTrue();
		assertThat(seek.path("payload").path("positionMs").asLong()).isEqualTo(600000); // clamped to duration
		assertThat(seek.path("payload").path("capturedAt").asLong()).isGreaterThanOrEqualTo(now);

		hostWs.send(event("playback:pause", roomId, "{\"positionMs\":5000,\"capturedAt\":%d}".formatted(now)));
		JsonNode pause = friendWs.nextOfType("playback:update");
		assertThat(pause.path("version").asLong()).isEqualTo(3);
		assertThat(pause.path("payload").path("playing").asBoolean()).isFalse();
	}

	@Test
	void membersPauseWhenTheHostsLastConnectionLeaves() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":1000,\"capturedAt\":%d}"
				.formatted(System.currentTimeMillis())));
		assertThat(friendWs.nextOfType("playback:update").path("payload").path("playing").asBoolean()).isTrue();

		// The host's connection goes (window closed): members stop where the host was.
		Thread.sleep(200);
		hostWs.session().close();
		JsonNode paused = friendWs.nextOfType("playback:update");
		assertThat(paused.path("payload").path("playing").asBoolean()).isFalse();
		assertThat(paused.path("payload").path("positionMs").asLong()).isGreaterThan(1000).isLessThan(10_000);
		assertThat(paused.path("version").asLong()).isEqualTo(2);

		// A host connection that (re)joined before the room lock was taken keeps it playing.
		Client back = connect(host);
		back.send(event("room:join", roomId, "{}"));
		back.send(event("playback:play", roomId, "{\"positionMs\":3000,\"capturedAt\":%d}"
				.formatted(System.currentTimeMillis())));
		assertThat(friendWs.nextOfType("playback:update").path("payload").path("playing").asBoolean()).isTrue();
		assertThat(roomService.hostLeft(host.id(), roomId, () -> true)).isNull();
		assertThat(roomService.hostLeft(friend.id(), roomId, () -> false)).isNull(); // not the host
		assertThat(roomService.hostLeft(host.id(), roomId, () -> false).playing()).isFalse();
	}

	@Test
	void anyoneWithTheCodeJoinsUpToTheLimit() throws Exception {
		TestUser host = signup();
		TestUser stranger = signup();
		TestUser blocked = signup();
		JsonNode room = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT)));
		String roomId = room.path("id").asString();
		String code = room.path("code").asString();
		assertThat(code).matches("[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}");
		Client hostWs = connect(host);

		String typed = code.substring(0, 4).toLowerCase() + "-" + code.substring(4); // as people type it
		JsonNode joined = body(call(HttpMethod.POST, "/api/rooms/join", stranger.accessToken(),
				"{\"code\":\"%s\"}".formatted(typed)));
		assertThat(joined.path("id").asString()).isEqualTo(roomId);
		assertThat(joined.path("members").findValuesAsString("id")).contains(stranger.id());
		assertThat(hostWs.nextOfType("room:update")).isNotNull();
		call(HttpMethod.POST, "/api/rooms/join", stranger.accessToken(), "{\"code\":\"%s\"}".formatted(code))
				.andExpect(status().isOk()); // already in

		call(HttpMethod.PUT, "/api/blocks/" + host.id(), blocked.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.POST, "/api/rooms/join", blocked.accessToken(), "{\"code\":\"%s\"}".formatted(code))
				.andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/rooms/join", blocked.accessToken(), "{\"code\":\"ZZZZ-ZZZZ\"}")
				.andExpect(status().isNotFound());

		for (int i = 0; i < 6; i++) { // host + stranger + 6 = 8, the limit
			call(HttpMethod.POST, "/api/rooms/join", signup().accessToken(), "{\"code\":\"%s\"}".formatted(code))
					.andExpect(status().isOk());
		}
		call(HttpMethod.POST, "/api/rooms/join", signup().accessToken(), "{\"code\":\"%s\"}".formatted(code))
				.andExpect(status().isConflict());

		TestUser guesser = signup();
		for (int i = 0; i < RoomController.MAX_CODE_ATTEMPTS_PER_MINUTE; i++) {
			call(HttpMethod.POST, "/api/rooms/join", guesser.accessToken(), "{\"code\":\"ZZZZZZZ%d\"}".formatted(i % 8 + 2));
		}
		call(HttpMethod.POST, "/api/rooms/join", guesser.accessToken(), "{\"code\":\"%s\"}".formatted(code))
				.andExpect(status().isTooManyRequests());
	}

	@Test
	void roomsNobodyIsInCloseAfterTwoSweeps() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String empty = body(createRoom(host, friend)).path("id").asString();
		String used = body(createRoom(friend, host)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", used, "{}"));
		friendWs.nextOfType("playback:update");

		emptyRooms.sweep(); // seen empty once: kept (a reconnect may be under way)
		call(HttpMethod.GET, "/api/rooms/" + empty, host.accessToken(), null).andExpect(status().isOk());
		emptyRooms.sweep(); // still nobody: closed, members told
		call(HttpMethod.GET, "/api/rooms/" + empty, host.accessToken(), null).andExpect(status().isNotFound());
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		call(HttpMethod.GET, "/api/rooms/" + used, friend.accessToken(), null).andExpect(status().isOk());

		// Someone back in time keeps it: empty at one sweep, joined before the next.
		friendWs.send(event("room:leave", used, "{}"));
		Thread.sleep(200);
		emptyRooms.sweep();
		friendWs.send(event("room:join", used, "{}"));
		friendWs.nextOfType("playback:update");
		emptyRooms.sweep();
		call(HttpMethod.GET, "/api/rooms/" + used, friend.accessToken(), null).andExpect(status().isOk());
	}

	@Autowired
	private com.mirattic.sync.ws.EmptyRooms emptyRooms;

	@Test
	void aMemberStillInTheRoomMarksWhatItSawAsRead() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client hostWs = connect(host);
		hostWs.send(event("chat:message", roomId, "{\"text\":\"while the panel was closed\"}"));
		friendWs.nextOfType("chat:message");
		assertThat(roomService.mine(friend.id()).get(0).unread()).isEqualTo(1); // joined, but not seen

		friendWs.send(event("room:read", roomId, "{}"));
		assertThat(friendWs.nextOfType("room:update")).isNotNull(); // my other apps refetch their counts
		assertThat(roomService.mine(friend.id()).get(0).unread()).isZero();
		Client strangerWs = connect(stranger);
		strangerWs.send(event("room:read", roomId, "{}"));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_member");
	}

	@Test
	void membersAskTheHostToPauseAtMostEveryThirtySeconds() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client hostWs = connect(host);
		Client friendWs = connect(friend);
		Client strangerWs = connect(stranger);

		friendWs.send(event("pause:request", roomId, "{\"reason\":\" 화장실 \"}"));
		JsonNode asked = hostWs.nextOfType("pause:request");
		assertThat(asked.path("roomId").asString()).isEqualTo(roomId);
		assertThat(asked.path("userId").asString()).isEqualTo(friend.id());
		assertThat(asked.path("payload").path("reason").asString()).isEqualTo("화장실");

		friendWs.send(event("pause:request", roomId, "{}"));
		assertThat(friendWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("rate_limited");
		assertThat(hostWs.nextOfType("pause:request")).isNull();

		hostWs.send(event("pause:request", roomId, "{}"));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		strangerWs.send(event("pause:request", roomId, "{}"));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_member");
		strangerWs.send(event("pause:request", roomId, "{\"reason\":\"%s\"}".formatted("x".repeat(201))));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
	}

	@Test
	void hostChangesContentAndMembersRestartOnIt() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"youtube","contentId":"not-a-video-id","title":"x"},"inviteIds":[]}""")
				.andExpect(status().isBadRequest());
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"netflix","contentId":"8123abc","title":"x"},"inviteIds":[]}""")
				.andExpect(status().isBadRequest());
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"netflix","contentId":"81234567","title":"x"},"inviteIds":[]}""")
				.andExpect(status().isOk());
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"laftel","contentId":"40522","title":"x"},"inviteIds":[]}""")
				.andExpect(status().isBadRequest());
		call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"laftel","contentId":"40522/40523","title":"x"},"inviteIds":[]}""")
				.andExpect(status().isOk());
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"youtube","contentId":"dQw4w9WgXcQ","title":"First"},"inviteIds":["%s"]}"""
				.formatted(friend.id()))).path("id").asString();
		accept(friend, roomId).andExpect(status().isOk());
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client hostWs = connect(host);
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":5000,\"capturedAt\":0}"));
		assertThat(friendWs.nextOfType("playback:update").path("version").asLong()).isEqualTo(1);

		String next = """
				{"provider":"youtube","contentId":"9bZkp7q19f0","title":"Second","series":"PLx_1-a"}""";
		friendWs.send(event("playback:content-change", roomId, next));
		assertThat(friendWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_host");
		hostWs.send(event("playback:content-change", roomId, """
				{"provider":"youtube","contentId":"bad","title":"x"}"""));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		hostWs.send(event("playback:content-change", roomId, "{\"provider\":\"youtube\"}"));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		hostWs.send(event("playback:content-change", roomId, """
				{"provider":"youtube","contentId":"9bZkp7q19f0","title":"x","series":"PL x/../"}"""));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		for (String[] bad : new String[][] {{"netflix", "81a"}, {"netflix", "1234567890123"},
				{"laftel", "40522/../x"}, {"laftel", "40522/"}}) {
			hostWs.send(event("playback:content-change", roomId, """
					{"provider":"%s","contentId":"%s","title":"x"}""".formatted(bad[0], bad[1])));
			assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		}

		hostWs.send(event("playback:content-change", roomId, next));
		JsonNode changed = friendWs.nextOfType("playback:update");
		assertThat(changed.path("version").asLong()).isEqualTo(2);
		assertThat(changed.path("payload").path("contentId").asString()).isEqualTo("9bZkp7q19f0");
		assertThat(changed.path("payload").path("positionMs").asLong()).isZero();
		assertThat(changed.path("payload").path("playing").asBoolean()).isFalse();
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + roomId, friend.accessToken(), null))
				.path("content").path("title").asString()).isEqualTo("Second");
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + roomId, friend.accessToken(), null))
				.path("content").path("series").asString()).isEqualTo("PLx_1-a");

		// The same video with other metadata (joined another playlist): no restart, members refetch the room.
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":7000,\"capturedAt\":0}"));
		assertThat(friendWs.nextOfType("playback:update").path("version").asLong()).isEqualTo(3);
		hostWs.send(event("playback:content-change", roomId,
				"{\"provider\":\"youtube\",\"contentId\":\"9bZkp7q19f0\",\"title\":\"Second\",\"series\":\"PLother\"}"));
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + roomId, friend.accessToken(), null))
				.path("content").path("series").asString()).isEqualTo("PLother");
		hostWs.send(event("playback:pause", roomId, "{\"positionMs\":8000,\"capturedAt\":0}"));
		JsonNode kept = friendWs.nextOfType("playback:update");
		assertThat(kept.path("version").asLong()).isEqualTo(4); // no restart in between
		assertThat(kept.path("payload").path("positionMs").asLong()).isEqualTo(8000);
	}

	@Test
	void membersChatWithMediaPositionsAndOutsidersCannot() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.nextOfType("playback:update");

		hostWs.send(event("chat:message", roomId, "{\"text\":\"  look at this  \",\"mediaPositionMs\":83000}"));
		JsonNode message = friendWs.nextOfType("chat:message");
		assertThat(message.path("userId").asString()).isEqualTo(host.id());
		assertThat(message.path("payload").path("text").asString()).isEqualTo("look at this");
		assertThat(message.path("payload").path("mediaPositionMs").asLong()).isEqualTo(83000);
		assertThat(hostWs.nextOfType("chat:message")).isNotNull(); // the sender gets it back too
		friendWs.send(event("chat:message", roomId, "{\"text\":\"no position\"}"));
		assertThat(hostWs.nextOfType("chat:message").path("payload").has("mediaPositionMs")).isFalse();

		for (String bad : new String[] {"{\"text\":\"   \"}", "{\"text\":\"%s\"}".formatted("x".repeat(1001)),
				"{\"text\":\"x\",\"mediaPositionMs\":-1}", "{\"text\":1}"}) {
			hostWs.send(event("chat:message", roomId, bad));
			assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		}
		Client strangerWs = connect(stranger);
		strangerWs.send(event("chat:message", roomId, "{\"text\":\"hi\"}"));
		assertThat(strangerWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_member");
		call(HttpMethod.GET, "/api/rooms/" + roomId + "/messages", stranger.accessToken(), null)
				.andExpect(status().isNotFound());

		JsonNode history = body(call(HttpMethod.GET, "/api/rooms/" + roomId + "/messages", friend.accessToken(), null));
		assertThat(written(history)).containsExactly("look at this", "no position");
	}

	@Test
	void messagesReachMembersOutsideTheRoomAndCountAsUnreadUntilSeen() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend); // online, but not in the room
		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.nextOfType("playback:update");

		hostWs.send(event("chat:message", roomId, "{\"text\":\"hello\"}"));
		assertThat(friendWs.nextOfType("chat:message").path("payload").hasNonNull("kind")).isFalse();
		// Reactions are gone (decision 78).
		hostWs.send(event("reaction:add", roomId, "{\"emoji\":\"🔥\"}"));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("unknown_type");

		// My own messages and the room's logs (the host's join) don't count.
		assertThat(myRoom(friend).path("unread").asLong()).isEqualTo(1);
		assertThat(myRoom(host).path("unread").asLong()).isZero();

		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		hostWs.nextOfType("room:update"); // the join's announcement: the next one is the leave's
		assertThat(myRoom(friend).path("unread").asLong()).isZero();
		hostWs.send(event("chat:message", roomId, "{\"text\":\"seen live\"}"));
		friendWs.nextOfType("chat:message");
		friendWs.send(event("room:leave", roomId, "{}"));
		assertThat(hostWs.nextOfType("room:update")).isNotNull(); // announced after the read mark
		assertThat(myRoom(friend).path("unread").asLong()).isZero();

		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		hostWs.nextOfType("room:update"); // the join's announcement: the next one is the leave's
		hostWs.send(event("chat:message", roomId, "{\"text\":\"seen before closing\"}"));
		friendWs.nextOfType("chat:message");
		friendWs.session().close();
		assertThat(hostWs.nextOfType("room:update")).isNotNull();
		assertThat(myRoom(friend).path("unread").asLong()).isZero();
	}

	@Autowired
	RoomLog roomLog;

	@Test
	void joinsLeavesAndTheHostsPlaybackAreLoggedInTheChat() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		JsonNode joined = hostWs.nextOfType("chat:log").path("payload");
		assertThat(joined.path("kind").asString()).isEqualTo("join");
		assertThat(joined.path("userId").asString()).isEqualTo(host.id());
		assertThat(joined.path("text").asString()).isEqualTo("Tester");
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		assertThat(hostWs.nextOfType("chat:log").path("userId").asString()).isEqualTo(friend.id());
		friendWs.nextOfType("chat:log"); // their own join
		// Another device of someone already in the room replaces the first (decision 89) and is no new join.
		Client friendWs2 = connect(friend);
		assertThat(friendWs.nextOfType("session:replaced")).isNotNull();
		friendWs2.send(event("room:join", roomId, "{}"));
		friendWs2.nextOfType("playback:update");
		friendWs = friendWs2;

		long now = System.currentTimeMillis();
		String command = "{\"positionMs\":%d,\"capturedAt\":%d}";
		hostWs.send(event("playback:play", roomId, command.formatted(1000, now)));
		JsonNode play = friendWs.nextOfType("chat:log").path("payload");
		assertThat(play.path("kind").asString()).isEqualTo("play");
		assertThat(play.path("mediaPositionMs").asLong()).isEqualTo(1000);
		hostWs.send(event("playback:play", roomId, command.formatted(2000, now))); // already playing: no line
		hostWs.send(event("playback:seek", roomId, command.formatted(60_000, now)));
		JsonNode seek = friendWs.nextOfType("chat:log").path("payload");
		assertThat(seek.path("kind").asString()).isEqualTo("seek");
		hostWs.send(event("playback:seek", roomId, command.formatted(90_000, now))); // each move its own line
		JsonNode next = friendWs.nextOfType("chat:log").path("payload");
		assertThat(next.path("id").asString()).isNotEqualTo(seek.path("id").asString());
		assertThat(next.path("mediaPositionMs").asLong()).isEqualTo(90_000);
		hostWs.send(event("playback:pause", roomId, command.formatted(91_000, now)));
		// A pause is held a moment (it may be a seek-bar drag); past the hold it is written.
		for (int i = 0; i < 100 && !loggedKinds(host, roomId).contains("pause"); i++) {
			roomLog.flushHeld(Long.MAX_VALUE);
			Thread.sleep(20);
		}
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("pause");
		// A "seek" to where it already is (e.g. the tab's title changed) is no move: no line.
		hostWs.send(event("playback:seek", roomId, command.formatted(91_500, System.currentTimeMillis())));
		// Past the end: logged where it lands (the 10 min duration); a second one lands there again, no line.
		hostWs.send(event("playback:seek", roomId, command.formatted(900_000, System.currentTimeMillis())));
		JsonNode end = friendWs.nextOfType("chat:log").path("payload");
		assertThat(end.path("kind").asString()).isEqualTo("seek");
		assertThat(end.path("mediaPositionMs").asLong()).isEqualTo(600_000);
		hostWs.send(event("playback:seek", roomId, command.formatted(950_000, System.currentTimeMillis())));
		hostWs.send(event("playback:content-change", roomId,
				"{\"provider\":\"youtube\",\"contentId\":\"abcdefghijk\",\"title\":\"Next one\"}"));
		JsonNode content = friendWs.nextOfType("chat:log").path("payload");
		assertThat(content.path("kind").asString()).isEqualTo("content");
		assertThat(content.path("text").asString()).isEqualTo("Next one");
		// Dragging the seek bar: pause, move, play within the hold is one "seek" line, no "pause" / "play".
		hostWs.send(event("playback:play", roomId, command.formatted(0, System.currentTimeMillis())));
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("play");
		hostWs.send(event("playback:pause", roomId, command.formatted(500, System.currentTimeMillis())));
		hostWs.send(event("playback:seek", roomId, command.formatted(20_000, System.currentTimeMillis())));
		hostWs.send(event("playback:play", roomId, command.formatted(30_000, System.currentTimeMillis())));
		JsonNode dragged = friendWs.nextOfType("chat:log").path("payload");
		assertThat(dragged.path("kind").asString()).isEqualTo("seek");
		assertThat(dragged.path("mediaPositionMs").asLong()).isEqualTo(30_000);
		// Small steps while held add up to a move.
		hostWs.send(event("playback:pause", roomId, command.formatted(30_000, System.currentTimeMillis())));
		for (int step = 31_000; step <= 33_000; step += 1_000) {
			hostWs.send(event("playback:seek", roomId, command.formatted(step, System.currentTimeMillis())));
		}
		long tp = System.currentTimeMillis();
		hostWs.send(event("playback:play", roomId, command.formatted(33_000, tp)));
		JsonNode stepped = friendWs.nextOfType("chat:log").path("payload");
		assertThat(stepped.path("kind").asString()).isEqualTo("seek");
		assertThat(stepped.path("mediaPositionMs").asLong()).isEqualTo(33_000);
		// The pause itself moving a little (1 s from where playback was) and one more small step add up.
		Thread.sleep(1_000); // a new second of the playback command budget
		long t = tp + 100; // playing from 33 000 at tp: expected 33 100 here
		hostWs.send(event("playback:pause", roomId, command.formatted(34_100, t)));
		hostWs.send(event("playback:seek", roomId, command.formatted(35_100, t)));
		hostWs.send(event("playback:play", roomId, command.formatted(35_100, t)));
		JsonNode small = friendWs.nextOfType("chat:log").path("payload");
		assertThat(small.path("kind").asString()).isEqualTo("seek");
		assertThat(small.path("mediaPositionMs").asLong()).isEqualTo(35_100);

		// The page says whether the seek bar is held (decision 86): a pause without it is written at once...
		String flagged = "{\"positionMs\":%d,\"capturedAt\":%d,\"scrubbing\":%b}";
		Thread.sleep(1_000);
		hostWs.send(event("playback:pause", roomId, flagged.formatted(36_000, System.currentTimeMillis(), false)));
		JsonNode paused = friendWs.nextOfType("chat:log").path("payload"); // no flush needed
		assertThat(paused.path("kind").asString()).isEqualTo("pause");
		assertThat(paused.path("mediaPositionMs").asLong()).isEqualTo(36_000);
		hostWs.send(event("playback:play", roomId, flagged.formatted(36_000, System.currentTimeMillis(), false)));
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("play");
		// ...one with it waits for the drag: let go and playing is one "seek" line,
		Thread.sleep(1_000);
		hostWs.send(event("playback:pause", roomId, flagged.formatted(36_100, System.currentTimeMillis(), true)));
		hostWs.send(event("playback:seek", roomId, flagged.formatted(50_000, System.currentTimeMillis(), true)));
		hostWs.send(event("playback:play", roomId, flagged.formatted(50_000, System.currentTimeMillis(), false)));
		JsonNode scrubbed = friendWs.nextOfType("chat:log").path("payload");
		assertThat(scrubbed.path("kind").asString()).isEqualTo("seek");
		assertThat(scrubbed.path("mediaPositionMs").asLong()).isEqualTo(50_000);
		// let go and still paused is a pause and a move, at once.
		Thread.sleep(1_000);
		long tq = System.currentTimeMillis();
		hostWs.send(event("playback:pause", roomId, flagged.formatted(50_100, tq, true)));
		hostWs.send(event("playback:seek", roomId, flagged.formatted(70_000, tq, true)));
		hostWs.send(event("playback:seek", roomId, flagged.formatted(70_000, tq, false)));
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("pause");
		JsonNode moved = friendWs.nextOfType("chat:log").path("payload");
		assertThat(moved.path("kind").asString()).isEqualTo("seek");
		assertThat(moved.path("mediaPositionMs").asLong()).isEqualTo(70_000);
		// A drag left hanging is written 30 s after it began, however long its moves go on.
		Thread.sleep(1_000);
		hostWs.send(event("playback:play", roomId, flagged.formatted(70_000, System.currentTimeMillis(), false)));
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("play");
		Thread.sleep(1_000);
		long began = System.currentTimeMillis();
		hostWs.send(event("playback:pause", roomId, flagged.formatted(70_100, began, true)));
		Thread.sleep(1_000); // still moving a second later
		hostWs.send(event("playback:seek", roomId, flagged.formatted(90_000, System.currentTimeMillis(), true)));
		friendWs.nextOfType("playback:update");
		roomLog.flushHeld(began + RoomLog.SCRUB_HOLD_MS - 1_000); // not yet
		assertThat(friendWs.nextOfType("chat:log")).isNull();
		roomLog.flushHeld(began + RoomLog.SCRUB_HOLD_MS + 500); // 30 s since it began, not since the last move
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("pause");
		assertThat(friendWs.nextOfType("chat:log").path("payload").path("kind").asString()).isEqualTo("seek");

		// Leaving: once the connection is gone for the grace period (0 here, two sweeps).
		friendWs.session().close();
		for (int i = 0; i < 100 && !loggedKinds(host, roomId).contains("leave"); i++) { // the close lands asynchronously
			roomLog.sweep();
			Thread.sleep(20);
		}
		JsonNode left;
		do { // the host also got every line above
			left = hostWs.nextOfType("chat:log").path("payload");
		} while (!left.path("kind").asString().equals("leave"));
		assertThat(left.path("kind").asString()).isEqualTo("leave");
		assertThat(left.path("userId").asString()).isEqualTo(friend.id());

		// Logs are in the history, can't be deleted or reported, and are never unread.
		JsonNode history = body(call(HttpMethod.GET, "/api/rooms/" + roomId + "/messages", host.accessToken(), null));
		List<String> kinds = new ArrayList<>();
		history.forEach(m -> kinds.add(m.path("kind").asString()));
		assertThat(kinds).containsExactly("join", "join", "play", "seek", "seek", "pause", "seek", "content", "play", "seek", "seek",
				"seek", "pause", "play", "seek", "pause", "seek", "play", "pause", "seek", "leave");
		call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/messages/" + play.path("id").asString(), host.accessToken(), null)
				.andExpect(status().isNotFound());
		assertThat(myRoom(friend).path("unread").asLong()).isZero();
	}

	@Test
	void theHostKicksAMemberAndHandsTheRoomOver() throws Exception {
		TestUser host = signup();
		TestUser a = signup();
		TestUser b = signup();
		befriend(host, a);
		befriend(host, b);
		JsonNode room = body(createRoom(host, a, b));
		String roomId = room.path("id").asString();
		String code = room.path("code").asString();
		String members = "/api/rooms/" + roomId + "/members/";
		Client hostWs = connect(host);
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.nextOfType("playback:update");

		call(HttpMethod.DELETE, members + b.id(), a.accessToken(), null).andExpect(status().isForbidden()); // host only
		call(HttpMethod.DELETE, members + host.id(), host.accessToken(), null).andExpect(status().isBadRequest());
		call(HttpMethod.DELETE, members + b.id(), host.accessToken(), null).andExpect(status().isNoContent());
		JsonNode kick = hostWs.nextOfType("chat:log").path("payload");
		assertThat(kick.path("kind").asString()).isEqualTo("kick");
		assertThat(kick.path("userId").asString()).isEqualTo(b.id());
		call(HttpMethod.GET, "/api/rooms/" + roomId, b.accessToken(), null).andExpect(status().isNotFound());
		// A leave line due for them (a sweep racing the kick) isn't written after the kick's line.
		assertThat(roomService.logPresence(roomId, b.id(), "leave")).isNull();
		call(HttpMethod.DELETE, members + b.id(), host.accessToken(), null).andExpect(status().isNotFound());
		// Not back by the code; the host's invite lets them in again.
		call(HttpMethod.POST, "/api/rooms/join", b.accessToken(), "{\"code\":\"" + code + "\"}").andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + b.id() + "\"]}")
				.andExpect(status().isOk());
		accept(b, roomId).andExpect(status().isOk());
		call(HttpMethod.DELETE, members + b.id(), host.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + b.id() + "\"]}")
				.andExpect(status().isOk());
		accept(b, roomId).andExpect(status().isOk());
		call(HttpMethod.DELETE, members + "me", b.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.POST, "/api/rooms/join", b.accessToken(), "{\"code\":\"" + code + "\"}").andExpect(status().isOk());

		String hostUrl = "/api/rooms/" + roomId + "/host";
		call(HttpMethod.POST, hostUrl, a.accessToken(), "{\"userId\":\"" + a.id() + "\"}").andExpect(status().isForbidden());
		call(HttpMethod.POST, hostUrl, host.accessToken(), "{\"userId\":\"" + host.id() + "\"}").andExpect(status().isBadRequest());
		call(HttpMethod.POST, hostUrl, host.accessToken(), "{\"userId\":\"" + a.id() + "\"}").andExpect(status().isNoContent());
		JsonNode handed;
		do { // after the second kick's line
			handed = hostWs.nextOfType("chat:log").path("payload");
		} while (handed.path("kind").asString().equals("kick"));
		assertThat(handed.path("kind").asString()).isEqualTo("host");
		assertThat(handed.path("userId").asString()).isEqualTo(a.id());
		JsonNode after = body(call(HttpMethod.GET, "/api/rooms/" + roomId, host.accessToken(), null));
		after.path("members").forEach(m -> assertThat(m.path("role").asString())
				.isEqualTo(m.path("user").path("id").asString().equals(a.id()) ? "HOST" : "MEMBER"));
		// The old host is a member now: playback is the new host's, and leaving doesn't close the room.
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":0,\"capturedAt\":0}"));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_host");
		call(HttpMethod.DELETE, members + "me", host.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.GET, "/api/rooms/" + roomId, a.accessToken(), null).andExpect(status().isOk());
	}

	private List<String> loggedKinds(TestUser user, String roomId) throws Exception {
		return body(call(HttpMethod.GET, "/api/rooms/" + roomId + "/messages", user.accessToken(), null))
				.findValuesAsString("kind");
	}

	/** Texts of the messages people wrote (not the room's logs). */
	private static List<String> written(JsonNode history) {
		List<String> texts = new ArrayList<>();
		history.forEach(m -> {
			if (!m.hasNonNull("kind")) {
				texts.add(m.path("text").asString());
			}
		});
		return texts;
	}

	@Test
	void aMessageRightAfterAReadMarkIsUnreadEvenInTheSameMillisecond() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		for (int i = 0; i < 200; i++) {
			roomService.read(friend.id(), roomId);
			chatMessages.save(new ChatMessage(roomId, host.id(), "m" + i, null, null));
			assertThat(roomService.mine(friend.id()).get(0).unread()).as("message %d", i).isEqualTo(1);
		}
	}

	@Test
	void membersMuteTheirOwnChatNotifications() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		String path = "/api/rooms/" + roomId + "/members/me/muted";
		Client mine = connect(friend);
		Client hostWs = connect(host);

		call(HttpMethod.PUT, path, friend.accessToken(), "{\"muted\":true}").andExpect(status().isNoContent());
		// My connection refetches (and applies the new setting at once); nobody else is told.
		JsonNode update = mine.nextOfType("room:update");
		assertThat(update.path("roomId").asString()).isEqualTo(roomId);
		assertThat(update.path("payload").path("muted").asBoolean()).isTrue(); // applied before any refetch
		assertThat(hostWs.nextOfType("room:update")).isNull();
		assertThat(myRoom(friend).path("muted").asBoolean()).isTrue();
		assertThat(myRoom(host).path("muted").asBoolean()).isFalse();
		call(HttpMethod.PUT, path, friend.accessToken(), "{\"muted\":false}").andExpect(status().isNoContent());
		assertThat(myRoom(friend).path("muted").asBoolean()).isFalse();
		call(HttpMethod.PUT, path, friend.accessToken(), "{}").andExpect(status().isBadRequest());
		call(HttpMethod.PUT, path, stranger.accessToken(), "{\"muted\":true}").andExpect(status().isNotFound());
	}

	@Test
	void olderMessagesComeInPagesWithoutGapsOrRepeats() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		String otherRoom = body(createRoom(friend, host)).path("id").asString(); // one room per host
		// Saved in a burst: many share a millisecond, which the page boundary must not split badly.
		for (int i = 0; i < 150; i++) {
			chatMessages.save(new ChatMessage(roomId, host.id(), "m" + i, null, null));
		}
		String elsewhere = chatMessages.save(new ChatMessage(otherRoom, host.id(), "x", null, null)).view().id();
		String messages = "/api/rooms/" + roomId + "/messages";

		JsonNode latest = body(call(HttpMethod.GET, messages, friend.accessToken(), null));
		assertThat(latest).hasSize(100);
		JsonNode older = body(call(HttpMethod.GET, messages + "?before=" + latest.get(0).path("id").asString(),
				friend.accessToken(), null));
		assertThat(older).hasSize(50);
		List<String> ids = new ArrayList<>(older.findValuesAsString("id"));
		ids.addAll(latest.findValuesAsString("id"));
		assertThat(ids).doesNotHaveDuplicates().hasSize(150);
		assertThat(body(call(HttpMethod.GET, messages + "?before=" + older.get(0).path("id").asString(),
				friend.accessToken(), null))).isEmpty();
		call(HttpMethod.GET, messages + "?before=" + elsewhere, friend.accessToken(), null)
				.andExpect(status().isNotFound());
	}

	@Autowired
	private ChatMessageRepository chatMessages;

	/** The caller's only room, as its room list shows it. */
	private JsonNode myRoom(TestUser u) throws Exception {
		JsonNode rooms = body(call(HttpMethod.GET, "/api/rooms", u.accessToken(), null));
		assertThat(rooms).hasSize(1);
		return rooms.get(0);
	}

	@Test
	void hostInvitesMoreFriendsIntoAnExistingRoom() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		TestUser late = signup();
		TestUser stranger = signup();
		befriend(host, friend);
		befriend(host, late);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		Client lateWs = connect(late);

		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", friend.accessToken(),
				"{\"userIds\":[\"%s\"]}".formatted(late.id())).andExpect(status().isForbidden());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(),
				"{\"userIds\":[\"%s\"]}".formatted(stranger.id())).andExpect(status().isBadRequest());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", stranger.accessToken(),
				"{\"userIds\":[\"%s\"]}".formatted(late.id())).andExpect(status().isNotFound());

		JsonNode room = body(call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(),
				"{\"userIds\":[\"%s\",\"%s\"]}".formatted(late.id(), friend.id())).andExpect(status().isOk()));
		assertThat(room.path("members")).hasSize(2); // an invitation, not a member yet (decision 85)
		assertThat(lateWs.nextOfType("room:invite").path("roomId").asString()).isEqualTo(roomId);
		assertThat(friendWs.nextOfType("room:invite")).isNull(); // already a member: not invited again
		assertThat(body(call(HttpMethod.GET, "/api/rooms", late.accessToken(), null)).size()).isZero();
		call(HttpMethod.GET, "/api/rooms/" + roomId, late.accessToken(), null).andExpect(status().isNotFound());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", late.accessToken(), null)).get(0).path("id")
				.asString()).isEqualTo(roomId);

		// Accepted: a member, the others told; the invitation is used up.
		assertThat(body(accept(late, roomId).andExpect(status().isOk())).path("members")).hasSize(3);
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		accept(late, roomId).andExpect(status().isNotFound());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", late.accessToken(), null)).size()).isZero();
		// Accepting without an invitation, or after declining: 404.
		accept(stranger, roomId).andExpect(status().isNotFound());
		TestUser declining = signup();
		befriend(host, declining);
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(),
				"{\"userIds\":[\"%s\"]}".formatted(declining.id())).andExpect(status().isOk());
		Client decliningWs = connect(declining);
		call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/invitation", declining.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(decliningWs.nextOfType("room:update")).isNotNull(); // their other apps drop the banner
		accept(declining, roomId).andExpect(status().isNotFound());
	}

	@Test
	void aKickedInviteeCantComeBackOnTheOldInvitation() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		JsonNode created = body(inviteToNewRoom(host, friend));
		String roomId = created.path("id").asString();
		// Invited, but in by the code instead; then kicked.
		call(HttpMethod.POST, "/api/rooms/join", friend.accessToken(), "{\"code\":\"" + created.path("code").asString() + "\"}")
				.andExpect(status().isOk());
		call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/members/" + friend.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		accept(friend, roomId).andExpect(status().isNotFound());
		// A new invite from the host lets them back.
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + friend.id() + "\"]}")
				.andExpect(status().isOk());
		accept(friend, roomId).andExpect(status().isOk());
	}

	@Test
	void invitationsEndWithTheRoomAndWithAnAnsweredWatchRequest() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		// Closed by the host: the invitee is told and the invitation is gone.
		String closing = body(inviteToNewRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		call(HttpMethod.DELETE, "/api/rooms/" + closing + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(friendWs.nextOfType("room:update").path("roomId").asString()).isEqualTo(closing);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", friend.accessToken(), null)).size()).isZero();

		// Invited, then asks to watch together; the host's invite answers it: in, and the invitation is used up.
		String roomId = body(inviteToNewRoom(host, friend)).path("id").asString();
		connect(host); // a watch request goes to an online friend
		call(HttpMethod.POST, "/api/rooms/requests", friend.accessToken(), "{\"friendId\":\"" + host.id() + "\"}")
				.andExpect(status().isAccepted());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + friend.id() + "\"]}")
				.andExpect(status().isOk());
		assertThat(friendWs.nextOfType("watch:answer").path("roomId").asString()).isEqualTo(roomId);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", friend.accessToken(), null)).size()).isZero();
		call(HttpMethod.GET, "/api/rooms/" + roomId, friend.accessToken(), null).andExpect(status().isOk());
	}

	@Test
	void aBlockDropsTheInvitationsBetweenThePair() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(inviteToNewRoom(host, friend)).path("id").asString();
		call(HttpMethod.PUT, "/api/blocks/" + host.id(), friend.accessToken(), null).andExpect(status().is2xxSuccessful());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", friend.accessToken(), null)).size()).isZero();
		accept(friend, roomId).andExpect(status().isNotFound());
	}

	@Test
	void concurrentAcceptsStayWithinTheLimitAndInviteOnce() throws Exception {
		TestUser host = signup();
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT))).path("id").asString();
		List<String> ids = new ArrayList<>();
		Map<String, TestUser> friends = new HashMap<>();
		for (int i = 0; i < 2 * RoomService.MAX_INVITES; i++) {
			TestUser friend = signup();
			befriend(host, friend);
			ids.add(friend.id());
			friends.put(friend.id(), friend);
		}
		List<List<String>> batches = List.of(ids.subList(0, RoomService.MAX_INVITES), ids.subList(RoomService.MAX_INVITES, ids.size()));
		CountDownLatch start = new CountDownLatch(1);
		List<Future<Integer>> results = new ArrayList<>();
		try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
			for (List<String> batch : batches) {
				results.add(pool.submit(() -> {
					start.await();
					return call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(),
							"{\"userIds\":%s}".formatted(json(batch))).andReturn().getResponse().getStatus();
				}));
			}
			start.countDown();
			for (Future<Integer> r : results) {
				assertThat(r.get()).isEqualTo(200); // invitations don't take a place (decision 85)
			}
		}
		// Everyone accepts at once: only as many as fit get in, the rest are told it's full and stay invited.
		List<Integer> accepted = new ArrayList<>();
		try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
			CountDownLatch go = new CountDownLatch(1);
			List<Future<Integer>> answers = new ArrayList<>();
			for (String id : ids) {
				TestUser invitee = friends.get(id);
				answers.add(pool.submit(() -> {
					go.await();
					return accept(invitee, roomId).andReturn().getResponse().getStatus();
				}));
			}
			go.countDown();
			for (Future<Integer> a : answers) {
				accepted.add(a.get());
			}
		}
		assertThat(accepted.stream().filter(st -> st == 200)).hasSize(RoomService.MAX_INVITES);
		assertThat(accepted.stream().filter(st -> st == 409)).hasSize(RoomService.MAX_INVITES);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + roomId, host.accessToken(), null)).path("members"))
				.hasSize(1 + RoomService.MAX_INVITES);

		TestUser once = signup();
		befriend(host, once);
		String small = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT))).path("id").asString();
		Client onceWs = connect(once);
		call(HttpMethod.POST, "/api/rooms/" + small + "/invites", host.accessToken(),
				"{\"userIds\":[\"%1$s\",\"%1$s\"]}".formatted(once.id())).andExpect(status().isOk());
		assertThat(onceWs.nextOfType("room:invite")).isNotNull();
		assertThat(onceWs.nextOfType("room:invite")).isNull(); // a repeated id is invited once
	}

	@Test
	void concurrentWatchRequestsSendOnlyOne() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		befriend(me, friend);
		Client friendWs = connect(friend);
		CountDownLatch start = new CountDownLatch(1);
		List<Future<Integer>> results = new ArrayList<>();
		try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
			for (int i = 0; i < 5; i++) {
				results.add(pool.submit(() -> {
					start.await();
					return call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(),
							"{\"friendId\":\"%s\"}".formatted(friend.id())).andReturn().getResponse().getStatus();
				}));
			}
			start.countDown();
			List<Integer> statuses = new ArrayList<>();
			for (Future<Integer> r : results) {
				statuses.add(r.get());
			}
			assertThat(statuses).containsExactlyInAnyOrder(202, 429, 429, 429, 429);
		}
		assertThat(friendWs.nextOfType("watch:request")).isNotNull();
		assertThat(friendWs.nextOfType("watch:request")).isNull();
	}

	private static String json(List<String> ids) {
		return ids.stream().map(id -> "\"" + id + "\"").collect(Collectors.joining(",", "[", "]"));
	}

	@Test
	void blockingSeparatesSharedRooms() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String hostsRoom = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", hostsRoom, "{}"));
		friendWs.nextOfType("playback:update");
		// Created after joining the host's room, as a room of the friend's own.
		String friendsRoom = body(createRoom(friend, host)).path("id").asString();
		Client hostWs = connect(host);
		hostWs.send(event("room:join", hostsRoom, "{}"));
		hostWs.nextOfType("playback:update");

		call(HttpMethod.PUT, "/api/blocks/" + friend.id(), host.accessToken(), null).andExpect(status().isNoContent());
		// The blocked user leaves the blocker's room (and its live events); the blocker leaves theirs.
		call(HttpMethod.GET, "/api/rooms/" + hostsRoom, friend.accessToken(), null).andExpect(status().isNotFound());
		call(HttpMethod.GET, "/api/rooms/" + friendsRoom, host.accessToken(), null).andExpect(status().isNotFound());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + hostsRoom, host.accessToken(), null)).path("members"))
				.hasSize(1);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + friendsRoom, friend.accessToken(), null)).path("members"))
				.hasSize(1);
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		hostWs.send(event("playback:play", hostsRoom, "{\"positionMs\":0,\"capturedAt\":0}"));
		assertThat(hostWs.nextOfType("playback:update")).isNotNull();
		assertThat(friendWs.nextOfType("playback:update")).isNull();
	}

	@Autowired
	private RoomService roomService;
	@Autowired
	private PlatformTransactionManager transactions;

	@Test
	void aBlockDuringRoomCreationStillSeparatesThePair() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		CountDownLatch created = new CountDownLatch(1);
		CountDownLatch commit = new CountDownLatch(1);
		try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
			// A room creation that has checked the friendship and added the friend, but not committed yet.
			Future<String> room = pool.submit(() -> new TransactionTemplate(transactions).execute(tx -> {
				String id = roomService.create(host.id(), new RoomContent(MediaProvider.mock, "c1", "Fake", null, null, null),
						List.of(friend.id()), List.of(friend.id())).id(); // joining at once (a watch request answered)
				created.countDown();
				try {
					commit.await();
				} catch (InterruptedException e) {
					throw new IllegalStateException(e);
				}
				return id;
			}));
			created.await();
			Future<Integer> block = pool.submit(() -> call(HttpMethod.PUT, "/api/blocks/" + host.id(),
					friend.accessToken(), null).andReturn().getResponse().getStatus());
			try {
				Thread.sleep(500);
				assertThat(block.isDone()).as("the block waits for the creation holding the friendship").isFalse();
			} finally {
				commit.countDown(); // never leave the pool waiting on the held transaction
			}
			assertThat(block.get()).isEqualTo(204);
			// The blocker leaves the blocked user's new room.
			call(HttpMethod.GET, "/api/rooms/" + room.get(), friend.accessToken(), null)
					.andExpect(status().isNotFound());
		}
	}

	@Autowired
	private JdbcTemplate jdbc;
	@Autowired
	private RoomController roomController;

	@Test
	void aNewDeviceReplacesTheOldOne() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		befriend(me, friend);
		Client friendWs = connect(friend);
		Client first = connect(me);
		friendWs.nextOfType("presence:update"); // I came online

		// Another device connects: the first is told and closed; I don't blink offline for my friends.
		String roomId = body(createRoom(me, friend)).path("id").asString();
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client second = connect(me);
		// Told once the server switched (the switch can land a moment after the client's handshake): whatever the
		// first sends from then on, before its close lands, counts for nothing.
		assertThat(first.nextOfType("session:replaced")).isNotNull();
		try {
			first.send("{\"type\":\"chat:message\",\"roomId\":\"%s\",\"payload\":{\"text\":\"late\"}}".formatted(roomId));
		} catch (IllegalStateException | java.io.IOException closedAlready) {
			// the close landed first: nothing sent either
		}
		assertThat(friendWs.nextOfType("chat:message")).isNull();
		for (int i = 0; i < 100 && first.session().isOpen(); i++) {
			Thread.sleep(20);
		}
		assertThat(first.session().isOpen()).isFalse();
		assertThat(second.session().isOpen()).isTrue();
		assertThat(friendWs.nextOfType("presence:update")).isNull();

		// Events reach the new device.
		call(HttpMethod.POST, "/api/rooms/requests", friend.accessToken(), "{\"friendId\":\"" + me.id() + "\"}")
				.andExpect(status().isAccepted());
		assertThat(second.nextOfType("watch:request")).isNotNull();

		// Two arriving together: one of them stays (they can't close each other).
		List<Future<Client>> both = new ArrayList<>();
		ExecutorService pool = Executors.newFixedThreadPool(2);
		for (int i = 0; i < 2; i++) {
			both.add(pool.submit(() -> connect(me)));
		}
		List<Client> clients = new ArrayList<>();
		for (Future<Client> f : both) {
			clients.add(f.get());
		}
		pool.shutdown();
		Thread.sleep(500);
		assertThat(clients.stream().filter((c) -> c.session().isOpen()).count()).isEqualTo(1);
	}

	@Test
	void invitationsAndWatchRequestsCountForThirtySeconds() throws Exception {
		TestUser host = signup();
		TestUser me = signup();
		befriend(host, me);
		Client meWs = connect(me);
		Client hostWs = connect(host);
		String roomId = body(inviteToNewRoom(host, me)).path("id").asString();
		assertThat(meWs.nextOfType("room:invite").path("payload").path("expiresInMs").asLong()).isEqualTo(30_000);
		long left = body(call(HttpMethod.GET, "/api/rooms/invitations", me.accessToken(), null)).get(0).path("expiresInMs").asLong();
		assertThat(left).isBetween(1L, 30_000L);

		// 31 s later: not listed, and accepting it is refused; inviting again starts it over.
		jdbc.update("UPDATE room_invitations SET invited_at = invited_at - 31000 WHERE room_id = ?", roomId);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/invitations", me.accessToken(), null)).size()).isZero();
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invitation", me.accessToken(), null).andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + me.id() + "\"]}")
				.andExpect(status().isOk());
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invitation", me.accessToken(), null).andExpect(status().isOk());

		// A watch request: 30 s left, listed; 31 s later neither listed nor answered by an invite.
		TestUser asker = signup();
		befriend(asker, host);
		Client askerWs = connect(asker);
		call(HttpMethod.POST, "/api/rooms/requests", asker.accessToken(), "{\"friendId\":\"" + host.id() + "\"}")
				.andExpect(status().isAccepted());
		assertThat(hostWs.nextOfType("watch:request").path("payload").path("expiresInMs").asLong()).isEqualTo(30_000);
		JsonNode outgoing = body(call(HttpMethod.GET, "/api/rooms/requests/outgoing", asker.accessToken(), null));
		assertThat(outgoing.get(0).path("friendId").asString()).isEqualTo(host.id());
		assertThat(outgoing.get(0).path("expiresInMs").asLong()).isBetween(1L, 30_000L);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/incoming", host.accessToken(), null)).get(0)
				.path("expiresInMs").asLong()).isBetween(1L, 30_000L);
		roomController.openWatchRequests.replaceAll((k, at) -> at - 31_000);
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/incoming", host.accessToken(), null)).size()).isZero();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests", asker.accessToken(), null)).size()).isZero();
		call(HttpMethod.DELETE, "/api/rooms/requests/incoming/" + asker.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(askerWs.nextOfType("watch:decline")).isNull(); // already over: not "declined"
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invites", host.accessToken(), "{\"userIds\":[\"" + asker.id() + "\"]}")
				.andExpect(status().isOk());
		assertThat(askerWs.nextOfType("room:invite")).isNotNull(); // too late to answer it: a plain invitation
		assertThat(askerWs.nextOfType("watch:answer")).isNull();
	}

	@Test
	void openWatchRequestsToMeAreListedUntilDismissed() throws Exception {
		TestUser host = signup();
		TestUser me = signup();
		befriend(host, me);
		connect(host);
		inviteToNewRoom(host, me); // an invitation I ignore
		long askedAt = body(call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), "{\"friendId\":\"" + host.id() + "\"}")
				.andExpect(status().isAccepted())).path("askedAt").asLong();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/outgoing", me.accessToken(), null)).get(0).path("askedAt")
				.asLong()).isEqualTo(askedAt);

		// A panel opened after the watch:request still shows it.
		JsonNode incoming = body(call(HttpMethod.GET, "/api/rooms/requests/incoming", host.accessToken(), null));
		assertThat(incoming.size()).isEqualTo(1);
		assertThat(incoming.get(0).path("id").asString()).isEqualTo(me.id());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/incoming", me.accessToken(), null)).size()).isZero();

		// Dismissed: gone, the requester is told (once), and a later invite is not its answer.
		Client meWs = connect(me);
		call(HttpMethod.DELETE, "/api/rooms/requests/incoming/" + me.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		JsonNode decline = meWs.nextOfType("watch:decline");
		assertThat(decline.path("userId").asString()).isEqualTo(host.id());
		assertThat(decline.path("payload").path("askedAt").asLong()).isEqualTo(askedAt); // which request
		call(HttpMethod.DELETE, "/api/rooms/requests/incoming/" + me.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(meWs.nextOfType("watch:decline")).isNull();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/incoming", host.accessToken(), null)).size()).isZero();
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests", me.accessToken(), null)).size()).isZero();

		// No longer friends: an open request isn't listed.
		TestUser other = signup();
		befriend(other, host);
		call(HttpMethod.POST, "/api/rooms/requests", other.accessToken(), "{\"friendId\":\"" + host.id() + "\"}")
				.andExpect(status().isAccepted());
		call(HttpMethod.DELETE, "/api/friends/" + other.id(), host.accessToken(), null).andExpect(status().is2xxSuccessful());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests/incoming", host.accessToken(), null)).size()).isZero();
	}

	@Test
	void noWatchRequestToAFriendInMyRoomRightNow() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		befriend(host, member);
		JsonNode room = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT)));
		String roomId = room.path("id").asString();
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk());
		Client hostWs = connect(host);
		connect(member);
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.nextOfType("playback:update");
		hostWs.nextOfType("room:update"); // the join's own announcement
		String to = "{\"friendId\":\"%s\"}";

		// The host is in our room: asking them would only invite me again.
		String detail = body(call(HttpMethod.POST, "/api/rooms/requests", member.accessToken(), to.formatted(host.id()))
				.andExpect(status().isConflict())).path("detail").asString();
		assertThat(detail).isEqualTo("already in the same room");
		assertThat(hostWs.nextOfType("watch:request")).isNull();

		// Out of the room (watching elsewhere, still online): asking works again.
		hostWs.send(event("room:leave", roomId, "{}"));
		assertThat(hostWs.nextOfType("room:update")).isNotNull(); // announced after the leave is applied
		call(HttpMethod.POST, "/api/rooms/requests", member.accessToken(), to.formatted(host.id()))
				.andExpect(status().isAccepted());
		assertThat(hostWs.nextOfType("watch:request").path("userId").asString()).isEqualTo(member.id());

		// Back in the room before answering: the open request can still be taken back.
		hostWs.send(event("room:join", roomId, "{}"));
		hostWs.nextOfType("room:update");
		call(HttpMethod.DELETE, "/api/rooms/requests/" + host.id(), member.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(hostWs.nextOfType("watch:cancel").path("userId").asString()).isEqualTo(member.id());
	}

	@Test
	void watchRequestsGoToOnlineFriendsOnlyAndAreThrottled() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(me, friend);
		String to = "{\"friendId\":\"%s\"}";

		call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isConflict()); // offline: nobody would see it
		Client friendWs = connect(friend);
		Client strangerWs = connect(stranger);
		call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), to.formatted(stranger.id()))
				.andExpect(status().isNotFound());
		assertThat(strangerWs.nextOfType("watch:request")).isNull();

		call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isAccepted());
		JsonNode request = friendWs.nextOfType("watch:request");
		assertThat(request.path("userId").asString()).isEqualTo(me.id());
		assertThat(request.path("payload").path("id").asString()).isEqualTo(me.id());
		call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isTooManyRequests());

		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests", me.accessToken(), null)).get(0).asString())
				.isEqualTo(friend.id()); // still waiting: a reopened panel gets it back
		// Taken back: the friend is told; not to a stranger; asking again is still throttled.
		call(HttpMethod.DELETE, "/api/rooms/requests/" + friend.id(), me.accessToken(), null)
				.andExpect(status().isNoContent());
		JsonNode cancel = friendWs.nextOfType("watch:cancel");
		assertThat(cancel.path("userId").asString()).isEqualTo(me.id());
		call(HttpMethod.DELETE, "/api/rooms/requests/" + friend.id(), me.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(friendWs.nextOfType("watch:cancel")).isNull(); // nothing open any more: no event
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests", me.accessToken(), null)).size()).isZero();
		call(HttpMethod.DELETE, "/api/rooms/requests/" + stranger.id(), me.accessToken(), null)
				.andExpect(status().isNotFound());
		assertThat(strangerWs.nextOfType("watch:cancel")).isNull();
		call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isTooManyRequests());

		// Answered by an invite: the request is closed.
		TestUser asker = signup();
		befriend(asker, friend);
		Client askerWs = connect(asker);
		call(HttpMethod.POST, "/api/rooms/requests", asker.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isAccepted());
		String roomId = body(createRoom(friend, asker)).path("id").asString();
		JsonNode answer = askerWs.nextOfType("watch:answer");
		assertThat(answer.path("roomId").asString()).isEqualTo(roomId);
		assertThat(answer.path("userId").asString()).isEqualTo(friend.id());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/requests", asker.accessToken(), null)).size()).isZero();
		createRoom(friend, asker); // another invite, answering nothing now: no watch:answer
		assertThat(askerWs.nextOfType("watch:answer")).isNull();

		// Already a member of the friend's room: inviting them again answers too.
		TestUser member = signup();
		befriend(member, friend);
		String theirs = body(createRoom(friend, member)).path("id").asString();
		Client memberWs = connect(member);
		call(HttpMethod.POST, "/api/rooms/requests", member.accessToken(), to.formatted(friend.id()))
				.andExpect(status().isAccepted());
		call(HttpMethod.POST, "/api/rooms/" + theirs + "/invites", friend.accessToken(), "{\"userIds\":[\"" + me.id() + "\"]}")
				.andExpect(status().isOk());
		assertThat(memberWs.nextOfType("watch:answer")).isNull(); // someone else invited: not an answer
		call(HttpMethod.POST, "/api/rooms/" + theirs + "/invites", friend.accessToken(), "{\"userIds\":[\"" + member.id() + "\"]}")
				.andExpect(status().isOk());
		assertThat(memberWs.nextOfType("watch:answer").path("roomId").asString()).isEqualTo(theirs);
	}

	@Test
	void playbackFloodsAreRateLimited() throws Exception {
		TestUser host = signup();
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT))).path("id").asString();
		Client hostWs = connect(host);
		for (int i = 0; i < 25; i++) {
			hostWs.send(event("playback:seek", roomId, "{\"positionMs\":%d,\"capturedAt\":0}".formatted(i)));
		}
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("rate_limited");
	}

	@Test
	void leavingStopsEventsAndHostLeavingClosesTheRoom() throws Exception {
		TestUser host = signup();
		TestUser friend = signup();
		befriend(host, friend);
		String roomId = body(createRoom(host, friend)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client hostWs = connect(host);

		call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/members/me", friend.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(hostWs.nextOfType("room:update")).isNotNull();
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":0,\"capturedAt\":0}"));
		assertThat(friendWs.nextOfType("playback:update")).isNull();

		call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		call(HttpMethod.GET, "/api/rooms/" + roomId, host.accessToken(), null).andExpect(status().isNotFound());
	}

	@Test
	void syncRequestEchoesTheRequestIdWithServerTime() throws Exception {
		Client ws = connect(signup());
		long before = System.currentTimeMillis();
		ws.send("{\"type\":\"sync:request\",\"reqId\":\"r1\",\"payload\":null}");
		JsonNode response = ws.nextOfType("sync:response");
		assertThat(response.path("payload").path("reqId").asString()).isEqualTo("r1");
		assertThat(response.path("serverTime").asLong()).isGreaterThanOrEqualTo(before);
	}

	/** A room with the invitees in it: invited, then each accepts (decision 85). A refused create is returned as is. */
	private ResultActions createRoom(TestUser host, TestUser... invitees) throws Exception {
		ResultActions created = inviteToNewRoom(host, invitees);
		if (created.andReturn().getResponse().getStatus() != 200) {
			return created;
		}
		String roomId = body(created).path("id").asString();
		for (TestUser invitee : invitees) {
			accept(invitee, roomId); // 404 when already a member (a watch request it answered)
		}
		return call(HttpMethod.GET, "/api/rooms/" + roomId, host.accessToken(), null);
	}

	/** A room whose invitees only got an invitation. */
	private ResultActions inviteToNewRoom(TestUser host, TestUser... invitees) throws Exception {
		String ids = java.util.Arrays.stream(invitees).map(u -> "\"" + u.id() + "\"").collect(Collectors.joining(","));
		return call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[%s]}".formatted(CONTENT, ids));
	}

	private ResultActions accept(TestUser invitee, String roomId) throws Exception {
		return call(HttpMethod.POST, "/api/rooms/" + roomId + "/invitation", invitee.accessToken(), null);
	}

	private static String event(String type, String roomId, String payload) {
		return "{\"type\":\"%s\",\"roomId\":\"%s\",\"payload\":%s}".formatted(type, roomId, payload);
	}
}
