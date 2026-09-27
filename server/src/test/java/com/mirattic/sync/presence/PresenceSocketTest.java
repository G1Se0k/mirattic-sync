package com.mirattic.sync.presence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mirattic.sync.IntegrationTest;
import java.util.concurrent.LinkedBlockingQueue;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import tools.jackson.databind.JsonNode;

class PresenceSocketTest extends IntegrationTest {

	@Test
	void presenceReachesFriendsOnlyAndRespectsPrivacy() throws Exception {
		TestUser a = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		befriend(a, friend);

		Client friendWs = connect(friend);
		Client strangerWs = connect(stranger);
		Client aWs = connect(a);

		JsonNode online = friendWs.nextOfType("presence:update");
		assertThat(online.path("userId").asString()).isEqualTo(a.id());
		assertThat(online.path("payload").path("status").asString()).isEqualTo("ONLINE");

		// Client-supplied userId is ignored; the server stamps the authenticated one.
		aWs.send("""
				{"type":"presence:update","userId":"%s","payload":{"provider":"youtube","contentId":"abc",
				 "title":"Video","positionMs":5000,"playing":true,"capturedAt":1}}""".formatted(stranger.id()));
		JsonNode watching = friendWs.nextOfType("presence:update");
		assertThat(watching.path("userId").asString()).isEqualTo(a.id());
		assertThat(watching.path("payload").path("status").asString()).isEqualTo("WATCHING");
		assertThat(watching.path("payload").path("media").path("title").asString()).isEqualTo("Video");
		assertThat(watching.path("payload").path("media").has("positionMs")).isFalse();

		assertThat(strangerWs.nextOfType("presence:update")).isNull();

		aWs.session().close();
		assertThat(friendWs.nextOfType("presence:update").path("payload").path("status").asString())
				.isEqualTo("OFFLINE");
	}

	@Test
	void blockedUserStopsReceivingPresence() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		befriend(a, b);
		Client bWs = connect(b);

		call(HttpMethod.PUT, "/api/blocks/" + b.id(), a.accessToken(), null);
		assertThat(bWs.nextOfType("friend:update")).isNotNull();

		connect(a);
		assertThat(bWs.nextOfType("presence:update")).isNull();
	}

	@Test
	void invalidPayloadIsRejected() throws Exception {
		TestUser a = signup();
		Client aWs = connect(a);
		aWs.send("""
				{"type":"presence:update","reqId":"1","payload":{"provider":"youtube","title":"x",
				 "canonicalUrl":"javascript:alert(1)","playing":true,"capturedAt":1}}""");
		JsonNode error = aWs.nextOfType("error");
		assertThat(error.path("payload").path("code").asString()).isEqualTo("bad_payload");
		assertThat(error.path("payload").path("reqId").asString()).isEqualTo("1");
	}

	@Test
	void ticketIsSingleUse() throws Exception {
		TestUser a = signup();
		String ticket = ticket(a);
		open(ticket, new LinkedBlockingQueue<>());
		assertThatThrownBy(() -> open(ticket, new LinkedBlockingQueue<>())).isNotNull();
		assertThatThrownBy(() -> open("forged", new LinkedBlockingQueue<>())).isNotNull();
	}
}
