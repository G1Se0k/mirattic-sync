package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Limit;
import org.springframework.http.HttpMethod;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.JsonNode;

/** Decisions 109–110: a room's name, member limit and public setting, and the public list. */
class RoomSettingsTest extends IntegrationTest {

	@Autowired
	private RoomRepository rooms;

	@Test
	void pagesGoOnPastRoomsMadeInTheSameMillisecond() {
		String tag = UUID.randomUUID().toString().substring(0, 8);
		for (int i = 0; i < 3; i++) {
			Room r = new Room(null, "host");
			r.configure("tie " + tag, 8, true);
			ReflectionTestUtils.setField(r, "createdAt", 1_000L);
			rooms.save(r);
		}
		String like = "%tie " + tag + "%";
		List<Room> first = rooms.findPublic(Long.MAX_VALUE, "", like, Limit.of(2));
		Room last = first.get(1);
		List<Room> rest = rooms.findPublic(last.getCreatedAt(), last.getId(), like, Limit.of(2));
		assertThat(first).hasSize(2);
		assertThat(rest).hasSize(1);
		assertThat(rest.get(0).getId()).isNotIn(first.stream().map(Room::getId).toList());
	}

	private static final String CONTENT = """
			{"provider":"youtube","contentId":"dQw4w9WgXcQ","title":"%s","durationMs":600000}""";

	private JsonNode create(TestUser host, String title, String settings) throws Exception {
		return body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]%s}".formatted(CONTENT.formatted(title), settings)));
	}

	/** In the room with a connection, so the public list shows it (rooms nobody is in are left out). */
	private Client present(TestUser user, String roomId) throws Exception {
		Client ws = connect(user);
		ws.send("{\"type\":\"room:join\",\"roomId\":\"%s\",\"payload\":{}}".formatted(roomId));
		ws.nextOfType("playback:update");
		return ws;
	}

	private JsonNode list(TestUser user, String query) throws Exception {
		return body(call(HttpMethod.GET, "/api/rooms/public?q=" + query, user.accessToken(), null));
	}

	@Test
	void settingsAtCreationAndTheirDefaults() throws Exception {
		TestUser host = signup();
		JsonNode plain = create(host, "Plain", "");
		assertThat(plain.path("memberLimit").asInt()).isEqualTo(8);
		assertThat(plain.path("isPublic").asBoolean()).isFalse();
		assertThat(plain.path("name").isMissingNode() || plain.path("name").isNull()).isTrue();

		JsonNode set = create(host, "Set", ",\"name\":\"  우리\\n방  \",\"memberLimit\":3,\"isPublic\":true");
		assertThat(set.path("name").asString()).isEqualTo("우리 방");
		assertThat(set.path("memberLimit").asInt()).isEqualTo(3);
		assertThat(set.path("isPublic").asBoolean()).isTrue();

		for (String bad : new String[] {",\"memberLimit\":1", ",\"memberLimit\":9", ",\"name\":\"" + "가".repeat(21) + "\""}) {
			call(HttpMethod.POST, "/api/rooms", host.accessToken(),
					"{\"content\":%s,\"inviteIds\":[]%s}".formatted(CONTENT.formatted("Bad"), bad))
					.andExpect(status().isBadRequest());
		}
	}

	@Test
	void aClosedRoomIsNamedInItsNotice() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		JsonNode room = create(host, "Video", ",\"name\":\"금요 영화\"");
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk());
		Client memberWs = connect(member);
		call(HttpMethod.DELETE, "/api/rooms/" + room.path("id").asString() + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(memberWs.nextOfType("room:closed").path("payload").path("title").asString()).isEqualTo("금요 영화");
	}

	@Test
	void theHostChangesSettingsNotBelowTheMembersIn() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		JsonNode room = create(host, "Limits", ",\"memberLimit\":2");
		String id = room.path("id").asString();
		String settings = "/api/rooms/" + id + "/settings";
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk());
		TestUser third = signup();
		call(HttpMethod.POST, "/api/rooms/join", third.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isConflict()); // 2 of 2

		call(HttpMethod.PUT, settings, member.accessToken(), "{\"name\":\"x\",\"memberLimit\":4,\"isPublic\":true}")
				.andExpect(status().isNotFound()); // not the host
		Client memberWs = connect(member);
		call(HttpMethod.PUT, settings, host.accessToken(), "{\"name\":\"새 이름\",\"memberLimit\":4,\"isPublic\":true}")
				.andExpect(status().isNoContent());
		assertThat(memberWs.nextOfType("room:update")).isNotNull();
		call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null)
				.andExpect(jsonPath("$.name").value("새 이름")).andExpect(jsonPath("$.memberLimit").value(4))
				.andExpect(jsonPath("$.isPublic").value(true));
		call(HttpMethod.PUT, settings, host.accessToken(), "{\"name\":\"\",\"memberLimit\":1,\"isPublic\":false}")
				.andExpect(status().isBadRequest());
		call(HttpMethod.POST, "/api/rooms/join", third.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk()); // 3 of 4 now
		call(HttpMethod.PUT, settings, host.accessToken(), "{\"name\":\"\",\"memberLimit\":2,\"isPublic\":false}")
				.andExpect(status().isConflict()); // 3 are in
	}

	@Test
	void thePublicListShowsLivePublicRoomsAndJoinsThem() throws Exception {
		String tag = UUID.randomUUID().toString().substring(0, 8);
		TestUser host = signup();
		TestUser other = signup();
		TestUser blocker = signup();
		JsonNode open = create(host, "Open" + tag, ",\"name\":\"방_" + tag + "\",\"memberLimit\":3,\"isPublic\":true");
		TestUser privateHost = signup(); // one connection per user: a host in two rooms would be in the last only
		JsonNode closed = create(privateHost, "Closed " + tag, ",\"isPublic\":false");
		JsonNode empty = create(other, "Empty " + tag, ",\"isPublic\":true"); // nobody in it
		Client hostWs = present(host, open.path("id").asString());
		present(privateHost, closed.path("id").asString());

		JsonNode listed = list(other, tag);
		assertThat(listed.path("next").isMissingNode() || listed.path("next").isNull()).isTrue(); // all on one page
		call(HttpMethod.GET, "/api/rooms/public?q=" + "a".repeat(101), other.accessToken(), null).andExpect(status().isBadRequest());
		for (String bad : new String[] {"nope", "123:", ":abc"}) {
			call(HttpMethod.GET, "/api/rooms/public?before=" + bad, other.accessToken(), null).andExpect(status().isBadRequest());
		}
		JsonNode found = listed.path("rooms");
		assertThat(found.findValuesAsString("id")).containsExactly(open.path("id").asString());
		JsonNode shown = found.get(0);
		assertThat(shown.path("name").asString()).isEqualTo("방_" + tag);
		assertThat(shown.path("hostName").asString()).isNotBlank();
		assertThat(shown.path("members").asInt()).isEqualTo(1);
		assertThat(shown.path("memberLimit").asInt()).isEqualTo(3);
		assertThat(shown.has("code")).isFalse();
		// By the video's title too, any case.
		assertThat(list(other, "OPEN" + tag.toUpperCase()).path("rooms").size()).isEqualTo(1);
		// `_` is a character, not any one: as a wildcard it would match the title ("Open" + tag).
		assertThat(list(other, "_" + tag.substring(1)).path("rooms").size()).isZero();

		call(HttpMethod.PUT, "/api/blocks/" + host.id(), blocker.accessToken(), null).andExpect(status().isNoContent());
		assertThat(list(blocker, tag).path("rooms").size()).isZero();
		call(HttpMethod.POST, "/api/rooms/" + open.path("id").asString() + "/join", blocker.accessToken(), null)
				.andExpect(status().isNotFound());

		call(HttpMethod.POST, "/api/rooms/" + open.path("id").asString() + "/join", other.accessToken(), null)
				.andExpect(status().isOk()).andExpect(jsonPath("$.members.length()").value(2));
		assertThat(hostWs.nextOfType("room:update")).isNotNull();
		// Kicked: not listed, and not back in from it.
		call(HttpMethod.DELETE, "/api/rooms/" + open.path("id").asString() + "/members/" + other.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(list(other, tag).path("rooms").size()).isZero();
		call(HttpMethod.POST, "/api/rooms/" + open.path("id").asString() + "/join", other.accessToken(), null)
				.andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/rooms/" + closed.path("id").asString() + "/join", other.accessToken(), null)
				.andExpect(status().isNotFound()); // not public
		call(HttpMethod.POST, "/api/rooms/" + empty.path("id").asString() + "/join", host.accessToken(), null)
				.andExpect(status().isOk()); // public, though not listed while empty
	}
}
