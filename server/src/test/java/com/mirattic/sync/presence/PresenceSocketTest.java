package com.mirattic.sync.presence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mirattic.sync.IntegrationTest;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpMethod;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;

class PresenceSocketTest extends IntegrationTest {

	@LocalServerPort
	int port;

	private record Client(WebSocketSession session, BlockingQueue<JsonNode> inbox) {
		JsonNode next() throws InterruptedException {
			return inbox.poll(3, TimeUnit.SECONDS);
		}

		JsonNode nextOfType(String type) throws InterruptedException {
			for (JsonNode e = next(); e != null; e = next()) {
				if (e.path("type").asString().equals(type)) {
					return e;
				}
			}
			return null;
		}

		void send(String text) throws Exception {
			session.sendMessage(new TextMessage(text));
		}
	}

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

	private Client connect(TestUser u) throws Exception {
		BlockingQueue<JsonNode> inbox = new LinkedBlockingQueue<>();
		return new Client(open(ticket(u), inbox), inbox);
	}

	private String ticket(TestUser u) throws Exception {
		return body(call(HttpMethod.POST, "/api/ws-ticket", u.accessToken(), null)).path("ticket").asString();
	}

	private WebSocketSession open(String ticket, BlockingQueue<JsonNode> inbox) throws Exception {
		return new StandardWebSocketClient().execute(new TextWebSocketHandler() {
			@Override
			protected void handleTextMessage(WebSocketSession session, TextMessage message) {
				inbox.add(json.readTree(message.getPayload()));
			}
		}, "ws://localhost:" + port + "/ws?ticket=" + ticket).get(5, TimeUnit.SECONDS);
	}
}
