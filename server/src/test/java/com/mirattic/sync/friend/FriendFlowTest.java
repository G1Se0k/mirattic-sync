package com.mirattic.sync.friend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;

class FriendFlowTest extends IntegrationTest {

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
