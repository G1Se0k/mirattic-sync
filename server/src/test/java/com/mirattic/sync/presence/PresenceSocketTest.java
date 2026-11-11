package com.mirattic.sync.presence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mirattic.sync.AuthStub;
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
	void photoChangeTellsFriendsAndRooms() throws Exception {
		TestUser a = signup();
		TestUser b = signup();
		TestUser blocker = signup();
		TestUser invitee = signup();
		befriend(a, b);
		befriend(a, blocker);
		befriend(a, invitee);
		call(HttpMethod.PUT, "/api/blocks/" + a.id(), blocker.accessToken(), null); // a is now on their blocked list
		call(HttpMethod.POST, "/api/rooms", a.accessToken(), """
				{"content":{"provider":"youtube","contentId":"9bZkp7q19f0","title":"T","durationMs":600000},"inviteIds":["%s"]}"""
				.formatted(invitee.id()));
		call(HttpMethod.DELETE, "/api/friends/" + a.id(), invitee.accessToken(), null); // the invitation may stay
		Client aWs = connect(a);
		Client bWs = connect(b);
		Client blockerWs = connect(blocker);
		Client inviteeWs = connect(invitee);

		AuthStub.PICTURES.put(a.id(), "https://avatar.mirattic.com/avatars/" + a.id() + "/p.jpg");
		try {
			call(HttpMethod.GET, "/api/me", a.accessToken(), null);
			assertThat(bWs.nextOfType("friend:update")).isNotNull(); // the friend list refetches the photo
			assertThat(aWs.nextOfType("room:update")).isNotNull(); // and the rooms they're in
			assertThat(blockerWs.nextOfType("friend:update")).isNotNull(); // one who blocked them: their blocked list
			// An invitee, friends no more: a full refetch, never room:update (that settles the invitation), before or after.
			java.util.List<String> toInvitee = new java.util.ArrayList<>();
			for (JsonNode e = inviteeWs.next(); e != null; e = inviteeWs.next()) {
				toInvitee.add(e.path("type").asString());
			}
			assertThat(toInvitee).contains("friend:update").doesNotContain("room:update");
			call(HttpMethod.GET, "/api/me", a.accessToken(), null);
			assertThat(bWs.nextOfType("friend:update")).isNull(); // unchanged: nothing sent
		} finally {
			AuthStub.PICTURES.remove(a.id());
		}
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
