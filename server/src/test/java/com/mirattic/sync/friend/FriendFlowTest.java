package com.mirattic.sync.friend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;

class FriendFlowTest extends IntegrationTest {

	@Autowired
	private BlockRepository blocks;

	@Test
	void requestAcceptAndRemove() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		befriend(a, b);

		call(HttpMethod.GET, "/api/friends", a.accessToken(), null)
				.andExpect(jsonPath("$[0].user.id").value(b.id()))
				.andExpect(jsonPath("$[0].presence.status").value("OFFLINE"));
		call(HttpMethod.GET, "/api/friends", b.accessToken(), null)
				.andExpect(jsonPath("$[0].user.id").value(a.id()));

		call(HttpMethod.DELETE, "/api/friends/" + b.id(), a.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.GET, "/api/friends", b.accessToken(), null).andExpect(jsonPath("$.length()").value(0));
	}

	@Test
	void mutualRequestsBecomeFriends() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		sendRequest(a, b).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(b.id()));
		sendRequest(b, a).andExpect(status().isOk());
		call(HttpMethod.GET, "/api/friends", a.accessToken(), null).andExpect(jsonPath("$.length()").value(1));
		sendRequest(a, b).andExpect(status().isConflict());
	}

	@Test
	void onlyTheAddresseeCanAccept() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		TestUser stranger = signup();
		sendRequest(a, b);
		String requestId = body(call(HttpMethod.GET, "/api/friends/requests", a.accessToken(), null))
				.path("outgoing").get(0).path("id").asString();

		call(HttpMethod.POST, "/api/friends/requests/" + requestId + "/accept", a.accessToken(), null)
				.andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/friends/requests/" + requestId + "/accept", stranger.accessToken(), null)
				.andExpect(status().isNotFound());
		call(HttpMethod.POST, "/api/friends/requests/" + requestId + "/accept", b.accessToken(), null)
				.andExpect(status().isNoContent());
	}

	@Test
	void blockEndsFriendshipAndPreventsRequestsBothWays() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		befriend(a, b);

		call(HttpMethod.PUT, "/api/blocks/" + b.id(), a.accessToken(), null).andExpect(status().isNoContent());
		call(HttpMethod.GET, "/api/friends", b.accessToken(), null).andExpect(jsonPath("$.length()").value(0));
		// Same answer as an unknown code, so the blocked user can't tell they were blocked.
		sendRequest(b, a).andExpect(status().isNotFound());
		sendRequest(a, b).andExpect(status().isNotFound());

		call(HttpMethod.DELETE, "/api/blocks/" + b.id(), a.accessToken(), null).andExpect(status().isNoContent());
		sendRequest(b, a).andExpect(status().isOk());
	}

	@Test
	void roomMembersAskEachOtherWithoutACode() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		TestUser stranger = signup();
		String byId = "/api/friends/requests/users/";
		call(HttpMethod.POST, byId + host.id(), member.accessToken(), null).andExpect(status().isNotFound()); // no room yet

		var room = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":{\"provider\":\"youtube\",\"contentId\":\"dQw4w9WgXcQ\",\"title\":\"Fake\",\"durationMs\":600000},\"inviteIds\":[]}"));
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk());

		call(HttpMethod.POST, byId + member.id(), stranger.accessToken(), null).andExpect(status().isNotFound());
		call(HttpMethod.POST, byId + host.id(), member.accessToken(), null)
				.andExpect(status().isOk()).andExpect(jsonPath("$.id").value(host.id()));
		call(HttpMethod.POST, byId + host.id(), member.accessToken(), null).andExpect(status().isConflict());
		call(HttpMethod.POST, byId + member.id(), host.accessToken(), null).andExpect(status().isOk()); // accepts theirs
		call(HttpMethod.GET, "/api/friends", host.accessToken(), null).andExpect(jsonPath("$[0].user.id").value(member.id()));
	}

	@Test
	void codeOnlyRefusesRoomMembersUnlessTheyAsked() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		var room = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":{\"provider\":\"youtube\",\"contentId\":\"dQw4w9WgXcQ\",\"title\":\"Fake\",\"durationMs\":600000},\"inviteIds\":[]}"));
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()));
		String privacy = "{\"presenceVisibility\":\"FRIENDS\",\"positionVisibility\":\"ROOM_ONLY\"%s}";
		call(HttpMethod.PUT, "/api/me/privacy", member.accessToken(), privacy.formatted(",\"friendCodeOnly\":true"))
				.andExpect(jsonPath("$.friendCodeOnly").value(true));
		// Left out (clients before it): unchanged.
		call(HttpMethod.PUT, "/api/me/privacy", member.accessToken(), privacy.formatted(""))
				.andExpect(jsonPath("$.friendCodeOnly").value(true));
		// One setting alone leaves the others.
		call(HttpMethod.PUT, "/api/me/privacy", member.accessToken(), "{\"presenceVisibility\":\"OFF\"}")
				.andExpect(jsonPath("$.presenceVisibility").value("OFF")).andExpect(jsonPath("$.friendCodeOnly").value(true));
		call(HttpMethod.PUT, "/api/me/privacy", member.accessToken(), "{\"friendCodeOnly\":true}")
				.andExpect(jsonPath("$.presenceVisibility").value("OFF")).andExpect(jsonPath("$.positionVisibility").value("ROOM_ONLY"));

		String byId = "/api/friends/requests/users/";
		call(HttpMethod.POST, byId + member.id(), host.accessToken(), null).andExpect(status().isForbidden());
		// Blocked while still in the room (the block saved, the separation not yet): 404 as any block, not 403.
		blocks.save(new Block(member.id(), host.id()));
		call(HttpMethod.POST, byId + member.id(), host.accessToken(), null).andExpect(status().isNotFound());
		blocks.deleteAll();
		call(HttpMethod.POST, byId + member.id(), member.accessToken(), null).andExpect(status().isBadRequest()); // myself
		call(HttpMethod.POST, byId + host.id(), member.accessToken(), null).andExpect(status().isOk()); // they ask me
		call(HttpMethod.POST, byId + host.id(), member.accessToken(), null).andExpect(status().isConflict()); // again
		call(HttpMethod.POST, byId + member.id(), host.accessToken(), null).andExpect(status().isOk()); // accepts theirs
		call(HttpMethod.POST, byId + member.id(), host.accessToken(), null).andExpect(status().isConflict()); // friends
	}

	@Test
	void cannotBefriendYourself() throws Exception {
		TestUser a = signup();
		sendRequest(a, a).andExpect(status().isBadRequest());
	}

	@Test
	void friendCodeInputIsForgivingButStrict() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		assertThat(b.friendCode()).matches("[2-9A-HJKMNP-Z]{8}");
		String typed = b.friendCode().substring(0, 4).toLowerCase() + "-" + b.friendCode().substring(4);
		sendRequest(a, typed).andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("Tester"));

		sendRequest(a, "ZZZZZZZZ".equals(b.friendCode()) ? "YYYYYYYY" : "ZZZZZZZZ").andExpect(status().isNotFound());
		sendRequest(a, "0O1IL000").andExpect(status().isNotFound());
		sendRequest(a, "").andExpect(status().isBadRequest());
	}

	@Test
	void regeneratingTheCodeRetiresTheOldOne() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		String fresh = body(call(HttpMethod.POST, "/api/me/friend-code", b.accessToken(), null)
				.andExpect(status().isOk())).path("friendCode").asString();
		assertThat(fresh).isNotEqualTo(b.friendCode());

		sendRequest(a, b.friendCode()).andExpect(status().isNotFound());
		sendRequest(a, fresh).andExpect(status().isOk());
	}

	private org.springframework.test.web.servlet.ResultActions sendRequest(TestUser from, TestUser to)
			throws Exception {
		return sendRequest(from, to.friendCode());
	}
}
