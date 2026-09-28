package com.mirattic.sync;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Shared context (one MySQL container) for all integration tests. Each test uses fresh random users. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.jwt-secret=test-secret-test-secret-test-secret-0123456789",
		"app.auth-rate-limit-per-minute=100000",
		"app.empty-room-sweep-ms=3600000" }) // tests sweep by hand
@AutoConfigureMockMvc
public abstract class IntegrationTest {

	protected record TestUser(String id, String email, String friendCode, String accessToken, String refreshToken) {
	}

	/** A live WebSocket connection with its received events. */
	protected record Client(WebSocketSession session, BlockingQueue<JsonNode> inbox) {
		public JsonNode next() throws InterruptedException {
			return inbox.poll(3, TimeUnit.SECONDS);
		}

		/** Skips other event types; null if none arrives within 3s. */
		public JsonNode nextOfType(String type) throws InterruptedException {
			for (JsonNode e = next(); e != null; e = next()) {
				if (e.path("type").asString().equals(type)) {
					return e;
				}
			}
			return null;
		}

		public void send(String text) throws Exception {
			session.sendMessage(new TextMessage(text));
		}
	}

	@LocalServerPort
	protected int port;
	@Autowired
	protected MockMvc mvc;
	@Autowired
	protected JsonMapper json;

	protected TestUser signup() throws Exception {
		String email = UUID.randomUUID() + "@example.com";
		JsonNode body = body(call(HttpMethod.POST, "/api/auth/signup", null,
				"{\"email\":\"" + email + "\",\"password\":\"password123\",\"displayName\":\"Tester\"}"));
		String accessToken = body.path("accessToken").asString();
		String friendCode = body(call(HttpMethod.GET, "/api/me", accessToken, null)).path("friendCode").asString();
		return new TestUser(body.path("user").path("id").asString(), email, friendCode, accessToken,
				body.path("refreshToken").asString());
	}

	protected ResultActions call(HttpMethod method, String path, String token, String jsonBody) throws Exception {
		MockHttpServletRequestBuilder req = request(method, path);
		if (token != null) {
			req.header("Authorization", "Bearer " + token);
		}
		if (jsonBody != null) {
			req.contentType(MediaType.APPLICATION_JSON).content(jsonBody);
		}
		return mvc.perform(req);
	}

	protected JsonNode body(ResultActions result) throws Exception {
		return json.readTree(result.andReturn().getResponse().getContentAsString());
	}

	protected ResultActions sendRequest(TestUser from, String friendCode) throws Exception {
		return call(HttpMethod.POST, "/api/friends/requests", from.accessToken(),
				"{\"friendCode\":\"" + friendCode + "\"}");
	}

	/** a sends, b accepts. */
	protected void befriend(TestUser a, TestUser b) throws Exception {
		sendRequest(a, b.friendCode());
		String requestId = body(call(HttpMethod.GET, "/api/friends/requests", b.accessToken(), null))
				.path("incoming").get(0).path("id").asString();
		call(HttpMethod.POST, "/api/friends/requests/" + requestId + "/accept", b.accessToken(), null);
	}

	protected Client connect(TestUser u) throws Exception {
		BlockingQueue<JsonNode> inbox = new LinkedBlockingQueue<>();
		return new Client(open(ticket(u), inbox), inbox);
	}

	protected String ticket(TestUser u) throws Exception {
		return body(call(HttpMethod.POST, "/api/ws-ticket", u.accessToken(), null)).path("ticket").asString();
	}

	protected WebSocketSession open(String ticket, BlockingQueue<JsonNode> inbox) throws Exception {
		return new StandardWebSocketClient().execute(new TextWebSocketHandler() {
			@Override
			protected void handleTextMessage(WebSocketSession session, TextMessage message) {
				inbox.add(json.readTree(message.getPayload()));
			}
		}, "ws://localhost:" + port + "/ws?ticket=" + ticket).get(5, TimeUnit.SECONDS);
	}
}
