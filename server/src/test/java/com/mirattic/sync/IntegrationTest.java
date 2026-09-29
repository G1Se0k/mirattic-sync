package com.mirattic.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Shared context (one MySQL container) for all integration tests. Each test uses fresh random users. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.auth-rate-limit-per-minute=100000",
		"app.auth.client-secret=" + AuthStub.CLIENT_SECRET, "app.auth.redirect-uri=https://sync.test/auth/callback",
		"app.empty-room-sweep-ms=3600000", "app.room-log-sweep-ms=3600000", "app.room-log-grace-ms=0" }) // tests sweep by hand
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

	@DynamicPropertySource
	static void auth(DynamicPropertyRegistry registry) {
		registry.add("app.auth.issuer", AuthStub::issuer);
	}

	@LocalServerPort
	protected int port;
	@Autowired
	protected MockMvc mvc;
	@Autowired
	protected JsonMapper json;

	protected static final String EXTENSION = "https://ffoifpjldcgdiipbhljkofgifmefgohk.chromiumapp.org/";
	protected static final String CALLBACK = "https://sync.test/auth/callback";

	/** Where the extension's sign-in window lands: a handoff code, and the verifier of the challenge it sent. */
	public record Handoff(String code, String verifier) {
	}

	/** A new Mirattic account signed in through the extension flow (Auth stubbed by {@link AuthStub}). */
	protected TestUser signup() throws Exception {
		String uid = UUID.randomUUID().toString();
		JsonNode body = body(redeem(signIn(uid, "Tester", false, Instant.now())).andExpect(status().isOk()));
		String accessToken = body.path("accessToken").asString();
		String friendCode = body(call(HttpMethod.GET, "/api/me", accessToken, null)).path("friendCode").asString();
		return new TestUser(uid, AuthStub.email(uid), friendCode, accessToken, body.path("refreshToken").asString());
	}

	/** /auth/start → (Auth: password typed at `authTime`) → /auth/callback, as launchWebAuthFlow would. */
	protected Handoff signIn(String uid, String name, boolean reauth, Instant authTime) throws Exception {
		String verifier = UUID.randomUUID() + "-abcdefgh";
		MockHttpServletResponse start = start(verifier, reauth);
		String authorize = start.getRedirectedUrl();
		assertThat(authorize).startsWith(AuthStub.issuer() + "/oauth2/authorize");
		assertThat(param(authorize, "prompt")).isEqualTo(reauth ? "login" : null);
		String code = AuthStub.code(uid, name, param(authorize, "code_challenge"), param(authorize, "redirect_uri"),
				authTime);
		MockHttpServletResponse cb = mvc.perform(get("/auth/callback").param("code", code)
				.param("state", param(authorize, "state")).cookie(start.getCookie("sync_login"))).andReturn().getResponse();
		assertThat(cb.getRedirectedUrl()).startsWith(EXTENSION + "?handoff=");
		String handoff = param(cb.getRedirectedUrl(), "handoff");
		assertThat(handoff).doesNotContain("."); // no token in a URL: a JWT always has dots, the random code never
		return new Handoff(handoff, verifier);
	}

	protected MockHttpServletResponse start(String verifier, boolean reauth) throws Exception {
		MockHttpServletResponse res = mvc.perform(get("/auth/start").param("redirect", EXTENSION)
				.param("challenge", AuthStub.s256(verifier)).param("reauth", String.valueOf(reauth)))
				.andExpect(status().isFound()).andReturn().getResponse();
		assertThat(param(res.getRedirectedUrl(), "redirect_uri")).isEqualTo(CALLBACK);
		return res;
	}

	protected ResultActions redeem(Handoff h) throws Exception {
		return call(HttpMethod.POST, "/api/auth/handoff", null,
				"{\"code\":\"" + h.code() + "\",\"verifier\":\"" + h.verifier() + "\"}");
	}

	protected static String param(String url, String name) {
		String raw = UriComponentsBuilder.fromUriString(url).build(true).getQueryParams().getFirst(name);
		return raw == null ? null : URLDecoder.decode(raw, StandardCharsets.UTF_8);
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
