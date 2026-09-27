package com.mirattic.sync.friend;

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
		sendRequest(a, b).andExpect(status().isNoContent());
		sendRequest(b, a).andExpect(status().isNoContent());
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
		sendRequest(b, a).andExpect(status().isConflict());
		sendRequest(a, b).andExpect(status().isConflict());

		// Blocked users can't find the blocker by email either.
		call(HttpMethod.GET, "/api/users/search?email=" + a.email(), b.accessToken(), null)
				.andExpect(jsonPath("$.length()").value(0));

		call(HttpMethod.DELETE, "/api/blocks/" + b.id(), a.accessToken(), null).andExpect(status().isNoContent());
		sendRequest(b, a).andExpect(status().isNoContent());
	}

	@Test
	void cannotBefriendYourself() throws Exception {
		TestUser a = signup();
		sendRequest(a, a).andExpect(status().isBadRequest());
	}

	private org.springframework.test.web.servlet.ResultActions sendRequest(TestUser from, TestUser to)
			throws Exception {
		return call(HttpMethod.POST, "/api/friends/requests", from.accessToken(), "{\"userId\":\"" + to.id() + "\"}");
	}
}
