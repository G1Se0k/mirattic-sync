package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.ResultActions;
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
