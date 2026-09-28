package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import com.mirattic.sync.presence.MediaProvider;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
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
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"youtube","contentId":"dQw4w9WgXcQ","title":"First"},"inviteIds":["%s"]}"""
				.formatted(friend.id()))).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", roomId, "{}"));
		friendWs.nextOfType("playback:update");
		Client hostWs = connect(host);
		hostWs.send(event("playback:play", roomId, "{\"positionMs\":5000,\"capturedAt\":0}"));
		assertThat(friendWs.nextOfType("playback:update").path("version").asLong()).isEqualTo(1);

		String next = """
				{"provider":"youtube","contentId":"9bZkp7q19f0","title":"Second"}""";
		friendWs.send(event("playback:content-change", roomId, next));
		assertThat(friendWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("not_host");
		hostWs.send(event("playback:content-change", roomId, """
				{"provider":"youtube","contentId":"bad","title":"x"}"""));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		hostWs.send(event("playback:content-change", roomId, "{\"provider\":\"youtube\"}"));
		assertThat(hostWs.nextOfType("error").path("payload").path("code").asString()).isEqualTo("bad_payload");
		for (String netflixId : new String[] {"81a", "1234567890123"}) {
			hostWs.send(event("playback:content-change", roomId, """
					{"provider":"netflix","contentId":"%s","title":"x"}""".formatted(netflixId)));
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
		assertThat(history.findValuesAsString("text")).containsExactly("look at this", "no position");
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
		assertThat(room.path("members")).hasSize(3);
		assertThat(lateWs.nextOfType("room:invite").path("roomId").asString()).isEqualTo(roomId);
		assertThat(friendWs.nextOfType("room:update")).isNotNull();
		assertThat(friendWs.nextOfType("room:invite")).isNull(); // already a member: not invited again
	}

	@Test
	void concurrentInvitesStayWithinTheLimitAndInviteOnce() throws Exception {
		TestUser host = signup();
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT))).path("id").asString();
		List<String> ids = new ArrayList<>();
		for (int i = 0; i < 2 * RoomService.MAX_INVITES; i++) {
			TestUser friend = signup();
			befriend(host, friend);
			ids.add(friend.id());
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
			List<Integer> statuses = new ArrayList<>();
			for (Future<Integer> r : results) {
				statuses.add(r.get());
			}
			assertThat(statuses).containsExactlyInAnyOrder(200, 400);
		}
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
		String friendsRoom = body(createRoom(friend, host)).path("id").asString();
		Client friendWs = connect(friend);
		friendWs.send(event("room:join", hostsRoom, "{}"));
		friendWs.nextOfType("playback:update");
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
				String id = roomService.create(host.id(), new RoomContent(MediaProvider.mock, "c1", "Fake", null, null),
						List.of(friend.id())).id();
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

	private ResultActions createRoom(TestUser host, TestUser invitee)
			throws Exception {
		return call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[\"%s\"]}".formatted(CONTENT, invitee.id()));
	}

	private static String event(String type, String roomId, String payload) {
		return "{\"type\":\"%s\",\"roomId\":\"%s\",\"payload\":%s}".formatted(type, roomId, payload);
	}
}
