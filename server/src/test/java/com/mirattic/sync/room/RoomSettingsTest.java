package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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

/** Decisions 109–110, 113: a room's name, member limit and public setting, the public list, and invitation links. */
class RoomSettingsTest extends IntegrationTest {

	@Autowired
	private com.mirattic.sync.ws.SocketHub hub;

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

	private org.springframework.test.web.servlet.ResultActions askToJoin(TestUser me, TestUser friend, boolean joinPublic)
			throws Exception {
		return call(HttpMethod.POST, "/api/rooms/requests", me.accessToken(),
				"{\"friendId\":\"%s\",\"joinPublic\":%s}".formatted(friend.id(), joinPublic));
	}

	/** Watching something, as friends see (WATCHING): what the app offers 합류 요청 on. */
	private static void watch(Client ws) throws Exception {
		ws.send("{\"type\":\"presence:update\",\"payload\":{\"provider\":\"youtube\",\"contentId\":\"dQw4w9WgXcQ\","
				+ "\"title\":\"Public\",\"playing\":true,\"capturedAt\":1}}");
		Thread.sleep(300); // the presence lands
	}

	@Test
	void askingAFriendInAPublicRoomJoinsIt() throws Exception {
		TestUser host = signup();
		JsonNode room = create(host, "Public", ",\"memberLimit\":3,\"isPublic\":true");
		String id = room.path("id").asString();
		Client hostWs = connect(host);

		TestUser me = signup();
		befriend(me, host);
		askToJoin(me, host, true).andExpect(status().isAccepted()); // online, in no room yet: asked
		hostWs.nextOfType("watch:request");
		hostWs.send("{\"type\":\"room:join\",\"roomId\":\"%s\",\"payload\":{}}".formatted(id));
		hostWs.nextOfType("playback:update");
		// In it, watching nothing (decision 114): joined at once all the same.
		askToJoin(me, host, true).andExpect(status().isOk()).andExpect(jsonPath("$.roomId").value(id));
		assertThat(hostWs.nextOfType("room:update")).isNotNull();
		// The request that was open is closed with it: the host no longer answers it.
		assertThat(hostWs.nextOfType("watch:cancel").path("userId").asString()).isEqualTo(me.id());
		call(HttpMethod.GET, "/api/rooms/" + id, me.accessToken(), null).andExpect(status().isOk());

		TestUser older = signup(); // a client before 1.3.0 doesn't ask for it: a request as before
		befriend(older, host);
		call(HttpMethod.POST, "/api/rooms/requests", older.accessToken(), "{\"friendId\":\"%s\"}".formatted(host.id()))
				.andExpect(status().isAccepted()).andExpect(jsonPath("$.askedAt").isNumber()); // no joinPublic at all

		TestUser third = signup(); // 3 of 3 now (host, me, third)
		befriend(third, host);
		askToJoin(third, host, true).andExpect(status().isOk());
		TestUser late = signup();
		befriend(late, host);
		askToJoin(late, host, true).andExpect(status().isConflict()); // full: no request either

		// Kicked from it: asked as before, for the host to answer (one who hasn't asked within the throttle).
		call(HttpMethod.DELETE, "/api/rooms/" + id + "/members/" + third.id(), host.accessToken(), null)
				.andExpect(status().isNoContent());
		askToJoin(third, host, true).andExpect(status().isAccepted());
	}

	@Test
	void inSeveralPublicRoomsTheOneOnWhatTheyWatchIsJoined() throws Exception {
		TestUser host = signup();
		String full = create(host, "First", ",\"memberLimit\":2,\"isPublic\":true").path("id").asString();
		String other = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"youtube","contentId":"9bZkp7q19f0","title":"Second","durationMs":600000},
				"inviteIds":[],"isPublic":true}""")).path("id").asString();
		Client hostWs = present(host, full);
		hostWs.send("{\"type\":\"room:join\",\"roomId\":\"%s\",\"payload\":{}}".formatted(other));
		hostWs.nextOfType("playback:update");
		TestUser filler = signup();
		call(HttpMethod.POST, "/api/rooms/" + full + "/join", filler.accessToken(), null).andExpect(status().isOk()); // 2 of 2
		hostWs.send("{\"type\":\"presence:update\",\"payload\":{\"provider\":\"youtube\",\"contentId\":\"9bZkp7q19f0\","
				+ "\"title\":\"Second\",\"playing\":true,\"capturedAt\":1}}");
		Thread.sleep(300);

		TestUser me = signup();
		befriend(me, host);
		askToJoin(me, host, true).andExpect(status().isOk()).andExpect(jsonPath("$.roomId").value(other));
	}

	@Test
	void aPrivateRoomOrHiddenPresenceIsAskedAsBefore() throws Exception {
		TestUser host = signup();
		present(host, create(host, "Private", "").path("id").asString());
		TestUser me = signup();
		befriend(me, host);
		askToJoin(me, host, true).andExpect(status().isAccepted());

		TestUser hidden = signup(); // what they watch hidden from friends: their public room isn't told either
		call(HttpMethod.PUT, "/api/me/privacy", hidden.accessToken(), "{\"presenceVisibility\":\"OFF\"}")
				.andExpect(status().isOk());
		watch(present(hidden, create(hidden, "Public", ",\"isPublic\":true").path("id").asString()));
		TestUser other = signup();
		befriend(other, hidden);
		askToJoin(other, hidden, true).andExpect(status().isAccepted());
	}

	@Test
	void friendsSeeThePublicRoomOneIsIn() throws Exception {
		TestUser host = signup();
		TestUser me = signup();
		befriend(me, host);
		Client meWs = connect(me);
		String id = create(host, "Movie", ",\"name\":\"금요 모임\",\"isPublic\":true").path("id").asString();
		Client hostWs = present(host, id);
		// Decision 114: told as they go in, watching or not, and in the friend list.
		JsonNode update = meWs.nextOfType("presence:update");
		while (update.path("payload").path("publicRoom").isMissingNode()) {
			update = meWs.nextOfType("presence:update");
		}
		assertThat(update.path("payload").path("publicRoom").path("name").asString()).isEqualTo("금요 모임");
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").path("publicRoom").path("name").asString()).isEqualTo("금요 모임");

		// Someone in it blocks me: not shown to me (as the public list hides it), still to other friends.
		TestUser blocker = signup();
		TestUser other = signup();
		befriend(other, host);
		call(HttpMethod.POST, "/api/rooms/" + id + "/join", blocker.accessToken(), null).andExpect(status().isOk());
		Client blockerWs = present(blocker, id);
		call(HttpMethod.PUT, "/api/blocks/" + me.id(), blocker.accessToken(), null).andExpect(status().is2xxSuccessful());
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").has("publicRoom")).isFalse();
		assertThat(body(call(HttpMethod.GET, "/api/friends", other.accessToken(), null)).get(0)
				.path("presence").path("publicRoom").path("name").asString()).isEqualTo("금요 모임");
		call(HttpMethod.DELETE, "/api/rooms/" + id + "/members/me", blocker.accessToken(), null).andExpect(status().isNoContent());
		blockerWs.session().close();

		// In two: the newer one is shown first, but hidden from me (the blocker is in it), so I see the other one.
		String second = create(host, "Movie", ",\"name\":\"토요 모임\",\"isPublic\":true").path("id").asString();
		hostWs.send("{\"type\":\"room:join\",\"roomId\":\"%s\",\"payload\":{}}".formatted(second)); // in both
		hostWs.nextOfType("playback:update");
		call(HttpMethod.POST, "/api/rooms/" + second + "/join", blocker.accessToken(), null).andExpect(status().isOk());
		assertThat(body(call(HttpMethod.GET, "/api/friends", other.accessToken(), null)).get(0)
				.path("presence").path("publicRoom").path("name").asString()).isEqualTo("토요 모임");
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").path("publicRoom").path("name").asString()).isEqualTo("금요 모임");
		// Joining from the row enters the room it shows.
		askToJoin(me, host, true).andExpect(status().isOk()).andExpect(jsonPath("$.roomId").value(id));
		call(HttpMethod.DELETE, "/api/rooms/" + id + "/members/me", me.accessToken(), null).andExpect(status().isNoContent());
		// Unblocked: I'm told to refetch, and the newer room shows again.
		call(HttpMethod.DELETE, "/api/blocks/" + me.id(), blocker.accessToken(), null).andExpect(status().isNoContent());
		assertThat(meWs.nextOfType("friend:update")).isNotNull();
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").path("publicRoom").path("name").asString()).isEqualTo("토요 모임");
		call(HttpMethod.DELETE, "/api/rooms/" + second + "/members/me", host.accessToken(), null).andExpect(status().isNoContent());

		// Made private: gone from it.
		call(HttpMethod.PUT, "/api/rooms/" + id + "/settings", host.accessToken(),
				"{\"name\":\"금요 모임\",\"memberLimit\":8,\"isPublic\":false}").andExpect(status().isNoContent());
		update = meWs.nextOfType("presence:update");
		while (!update.path("payload").path("publicRoom").isMissingNode()) {
			update = meWs.nextOfType("presence:update");
		}
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").has("publicRoom")).isFalse();

		// Their activity hidden from friends: not shown even in a public room.
		call(HttpMethod.PUT, "/api/rooms/" + id + "/settings", host.accessToken(),
				"{\"name\":\"금요 모임\",\"memberLimit\":8,\"isPublic\":true}").andExpect(status().isNoContent());
		update = meWs.nextOfType("presence:update");
		while (update.path("payload").path("publicRoom").isMissingNode()) {
			update = meWs.nextOfType("presence:update");
		}
		call(HttpMethod.PUT, "/api/me/privacy", host.accessToken(), "{\"presenceVisibility\":\"OFF\"}").andExpect(status().isOk());
		// Told at once, not left showing until their next change (earlier updates may still be queued before it).
		update = meWs.nextOfType("presence:update");
		while (update != null && update.path("payload").has("publicRoom")) {
			update = meWs.nextOfType("presence:update");
		}
		assertThat(update).isNotNull();
		assertThat(body(call(HttpMethod.GET, "/api/friends", me.accessToken(), null)).get(0)
				.path("presence").has("publicRoom")).isFalse();
		hostWs.session().close();
	}

	private org.springframework.test.web.servlet.ResultActions joinCode(TestUser me, String code, String others) throws Exception {
		return call(HttpMethod.POST, "/api/rooms/join" + (others == null ? "" : "?others=" + others), me.accessToken(),
				"{\"code\":\"%s\"}".formatted(code));
	}

	@Test
	void joiningAnotherRoomLeavesTheOneIWasIn() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		JsonNode roomA = create(a, "A", ",\"isPublic\":true");
		JsonNode roomB = create(b, "B", ",\"isPublic\":true");
		Client aWs = present(a, roomA.path("id").asString());
		present(b, roomB.path("id").asString());

		// A member: out of the old room at once, and its members told.
		TestUser me = signup();
		joinCode(me, roomA.path("code").asString(), "ask").andExpect(status().isOk());
		joinCode(me, roomB.path("code").asString(), "ask").andExpect(status().isOk());
		assertThat(aWs.nextOfType("room:update")).isNotNull();
		call(HttpMethod.GET, "/api/rooms/" + roomA.path("id").asString(), me.accessToken(), null).andExpect(status().isNotFound());
		assertThat(body(call(HttpMethod.GET, "/api/rooms", me.accessToken(), null))).hasSize(1);

		// A host joining a room hidden from them (a block): the same 404 as an unknown code, not asked first.
		TestUser blocker = signup();
		JsonNode hidden = create(blocker, "H", "");
		call(HttpMethod.PUT, "/api/blocks/" + a.id(), blocker.accessToken(), null).andExpect(status().isNoContent());
		joinCode(a, hidden.path("code").asString(), "ask").andExpect(status().isNotFound());

		// A host: asked first (nothing changes), then their room closes once they confirm.
		joinCode(a, roomB.path("code").asString(), "ask").andExpect(status().isConflict());
		call(HttpMethod.GET, "/api/rooms/" + roomB.path("id").asString(), a.accessToken(), null).andExpect(status().isNotFound());
		joinCode(a, roomB.path("code").asString(), "close").andExpect(status().isOk());
		call(HttpMethod.GET, "/api/rooms/" + roomA.path("id").asString(), b.accessToken(), null).andExpect(status().isNotFound());
		joinCode(me, "ZZZZ2222", "ask").andExpect(status().isNotFound()); // an unknown code: said so, not asked

		// Apps before 1.3.1 say nothing: rooms kept, as before.
		TestUser old = signup();
		JsonNode roomC = create(old, "C", "");
		joinCode(old, roomB.path("code").asString(), null).andExpect(status().isOk());
		call(HttpMethod.GET, "/api/rooms/" + roomC.path("id").asString(), old.accessToken(), null).andExpect(status().isOk());
	}

	@Test
	void withNoVideoInTheHostsBrowserTheRoomShowsNone() throws Exception {
		TestUser host = signup();
		JsonNode room = create(host, "Movie", ",\"isPublic\":true");
		String id = room.path("id").asString();
		assertThat(room.path("videoAway").asBoolean()).isFalse(); // just made from the host's browser: on the way in
		((java.util.Map<?, ?>) ReflectionTestUtils.getField(hub, "madeUntil")).clear(); // past that (or a restart): none
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + id, host.accessToken(), null)).path("videoAway").asBoolean()).isTrue();
		Client hostWs = present(host, id);
		TestUser member = signup();
		joinCode(member, room.path("code").asString(), "ask").andExpect(status().isOk());
		Client memberWs = present(member, id);

		hostWs.send("{\"type\":\"room:host-video\",\"roomId\":\"%s\",\"payload\":{\"watching\":false}}".formatted(id));
		assertThat(memberWs.nextOfType("room:update")).isNotNull(); // refetched: shown without a video
		for (int i = 0; i < 20 && !body(call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null)).path("videoAway").asBoolean(); i++) {
			Thread.sleep(50);
		}
		JsonNode view = body(call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null));
		assertThat(view.path("videoAway").asBoolean()).isTrue();
		assertThat(view.path("content").path("title").asString()).isEqualTo("Movie"); // kept for when it's back
		JsonNode listed = list(member, "");
		JsonNode mine = null;
		for (JsonNode r : listed.path("rooms")) {
			if (id.equals(r.path("id").asString())) {
				mine = r;
			}
		}
		assertThat(mine).isNotNull();
		assertThat(mine.has("title")).isFalse(); // listed as 영상 없음
		assertThat(mine.has("provider")).isFalse();
		assertThat(body(call(HttpMethod.GET, "/api/invite/" + room.path("code").asString(), null, null)).has("title")).isFalse();

		hostWs.send("{\"type\":\"room:host-video\",\"roomId\":\"%s\",\"payload\":{\"watching\":true}}".formatted(id));
		for (int i = 0; i < 20 && body(call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null)).path("videoAway").asBoolean(); i++) {
			Thread.sleep(50); // the report lands
		}
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null)).path("videoAway").asBoolean()).isFalse();
		assertThat(body(call(HttpMethod.GET, "/api/invite/" + room.path("code").asString(), null, null)).path("title").asString())
				.isEqualTo("Movie");
	}

	@Test
	void aHostWhoCameInAndLeftShowsNoVideoAtOnceEvenJustAfterMakingIt() throws Exception {
		TestUser host = signup();
		JsonNode room = create(host, "Quick", "");
		String id = room.path("id").asString();
		present(host, id).session().close(); // in (the grace ends), then out
		boolean away = false;
		for (int i = 0; i < 40 && !away; i++) {
			away = body(call(HttpMethod.GET, "/api/invite/" + room.path("code").asString(), null, null)).path("title").isMissingNode();
			Thread.sleep(25);
		}
		assertThat(away).isTrue();
	}

	@Test
	void anInvitationLinkShowsItsRoomToAnyoneButNotItsCodeOrMembers() throws Exception {
		TestUser host = signup();
		JsonNode room = create(host, "Video", ",\"name\":\"금요 \\\"<영화>\\\"\",\"memberLimit\":4");
		String code = room.path("code").asString();
		present(host, room.path("id").asString()); // its video shows while the host is in it (decision 115)
		JsonNode shown = body(call(HttpMethod.GET, "/api/invite/" + code, null, null).andExpect(status().isOk()));
		assertThat(shown.path("name").asString()).isEqualTo("금요 \"<영화>\"");
		assertThat(shown.path("provider").asString()).isEqualTo("youtube");
		assertThat(shown.path("title").asString()).isEqualTo("Video");
		assertThat(shown.path("hostName").asString()).isEqualTo("Tester");
		assertThat(shown.path("members").asInt()).isEqualTo(1);
		assertThat(shown.path("memberLimit").asInt()).isEqualTo(4);
		assertThat(shown.path("isPublic").asBoolean()).isFalse();
		assertThat(shown.propertyNames()).containsExactlyInAnyOrder("name", "provider", "title", "hostName", "members",
				"memberLimit", "isPublic");
		// Typed as the panel takes it, and the page itself.
		call(HttpMethod.GET, "/api/invite/" + code.toLowerCase().substring(0, 4) + "-" + code.toLowerCase().substring(4), null, null)
				.andExpect(status().isOk());
		// The page's link preview (chat apps don't run its script): the room, escaped, the logo, not the members.
		String page = mvc.perform(get("/r/" + code)).andExpect(status().isOk()).andReturn().getResponse()
				.getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
		assertThat(page).contains("<meta property=\"og:title\" content=\"Tester님의 같이 보기 초대: 금요 &quot;&lt;영화&gt;&quot;\">")
				.contains("<meta property=\"og:description\" content=\"YouTube · Video\">")
				.contains("/landing/logo.png").contains("twitter:card").doesNotContain("1/4").doesNotContain("<!-- link preview");
		assertThat(mvc.perform(get("/r/" + "Z".repeat(8))).andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
				.contains("Mirattic Sync 같이 보기 초대");
		// Unknown or malformed: the same 404.
		call(HttpMethod.GET, "/api/invite/" + "Z".repeat(8), null, null).andExpect(status().isNotFound());
		call(HttpMethod.GET, "/api/invite/nope", null, null).andExpect(status().isNotFound());
		// Closed: gone.
		call(HttpMethod.DELETE, "/api/rooms/" + room.path("id").asString() + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		call(HttpMethod.GET, "/api/invite/" + code, null, null).andExpect(status().isNotFound());
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
