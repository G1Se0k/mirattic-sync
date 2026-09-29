package com.mirattic.sync.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.AuthStub;
import com.mirattic.sync.IntegrationTest;
import jakarta.servlet.http.Cookie;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.databind.JsonNode;

class MiratticLoginTest extends IntegrationTest {

	private static final String EXTENSION = "https://ffoifpjldcgdiipbhljkofgifmefgohk.chromiumapp.org/";
	private static final String CALLBACK = "https://sync.test/auth/callback";

	/** The extension's side of one sign-in: what launchWebAuthFlow ends on, plus its verifier. */
	private record Landing(Map<String, String> params, String verifier) {
	}

	@Test
	void firstLoginCreatesTheSyncProfileAndHandsOffAuthTokens() throws Exception {
		String uid = UUID.randomUUID().toString();
		Landing landing = signIn(uid, "Alice");
		JsonNode tokens = body(handoff(landing).andExpect(status().isOk()));
		assertThat(tokens.path("user").path("id").asString()).isEqualTo(uid);

		String access = tokens.path("accessToken").asString();
		call(HttpMethod.GET, "/api/me", access, null)
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.id").value(uid))
				.andExpect(jsonPath("$.displayName").value("Alice"))
				.andExpect(jsonPath("$.friendCode").exists());
		// The WebSocket ticket (and so everything else) works with an Auth token.
		call(HttpMethod.POST, "/api/ws-ticket", access, null).andExpect(status().isOk());

		// Second login of the same UID: same profile, not a new one.
		JsonNode again = body(handoff(signIn(uid, "Renamed")).andExpect(status().isOk()));
		assertThat(again.path("user").path("displayName").asString()).isEqualTo("Alice");
	}

	@Test
	void handoffIsSingleUseAndBoundToTheExtensionVerifier() throws Exception {
		Landing landing = signIn(UUID.randomUUID().toString(), "Bob");
		call(HttpMethod.POST, "/api/auth/handoff", null, handoffBody(landing.params().get("handoff"), "x".repeat(43)))
				.andExpect(status().isUnauthorized());
		// A wrong verifier burns the code.
		handoff(landing).andExpect(status().isUnauthorized());

		Landing other = signIn(UUID.randomUUID().toString(), "Bob");
		handoff(other).andExpect(status().isOk());
		handoff(other).andExpect(status().isUnauthorized());
	}

	@Test
	void refreshAndLogoutAreRelayedToAuth() throws Exception {
		JsonNode tokens = body(handoff(signIn(UUID.randomUUID().toString(), "Carol")));
		String refresh = tokens.path("refreshToken").asString();
		assertThat(refresh).hasSize(128);

		JsonNode rotated = body(call(HttpMethod.POST, "/api/auth/refresh", null, refreshBody(refresh))
				.andExpect(status().isOk()));
		String next = rotated.path("refreshToken").asString();
		assertThat(next).isNotEqualTo(refresh);
		call(HttpMethod.GET, "/api/me", rotated.path("accessToken").asString(), null).andExpect(status().isOk());
		// Auth refuses the rotated-away token: the client is told to sign out (401), not to retry.
		call(HttpMethod.POST, "/api/auth/refresh", null, refreshBody(refresh)).andExpect(status().isUnauthorized());

		call(HttpMethod.POST, "/api/auth/logout", null, refreshBody(next)).andExpect(status().isNoContent());
		assertThat(AuthStub.REVOKED).contains(next);
		call(HttpMethod.POST, "/api/auth/refresh", null, refreshBody(next)).andExpect(status().isUnauthorized());
	}

	@Test
	void onlyAuthAccessTokensForThisClientAreAccepted() throws Exception {
		String uid = body(handoff(signIn(UUID.randomUUID().toString(), "Dan"))).path("user").path("id").asString();
		call(HttpMethod.GET, "/api/me", AuthStub.accessToken(uid), null).andExpect(status().isOk());
		// Flow's token, an ID token (no scope), an unknown UID.
		call(HttpMethod.GET, "/api/me", AuthStub.sign(Map.of("sub", uid, "aud", "mirattic-flow", "scope", "openid")), null)
				.andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", AuthStub.sign(Map.of("sub", uid, "aud", AuthStub.CLIENT_ID)), null)
				.andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", AuthStub.accessToken(UUID.randomUUID().toString()), null)
				.andExpect(status().isUnauthorized());
		// Legacy tokens still work (dual acceptance).
		call(HttpMethod.GET, "/api/me", signup().accessToken(), null).andExpect(status().isOk());
	}

	@Test
	void startAcceptsOnlyOurExtensionAndCallbackNeedsTheBrowserCookie() throws Exception {
		mvc.perform(get("/auth/start").param("redirect", "https://evil.example/").param("challenge", challenge("v".repeat(43))))
				.andExpect(status().isBadRequest());

		MockHttpServletResponse start = start("w".repeat(43));
		String state = param(start.getRedirectedUrl(), "state");
		// Someone else's browser (no cookie): login CSRF refused, reported to the extension.
		MockHttpServletResponse cb = mvc.perform(get("/auth/callback").param("code", "c").param("state", state))
				.andReturn().getResponse();
		assertThat(cb.getRedirectedUrl()).startsWith(EXTENSION).contains("error=state_mismatch");
		// The state is single use.
		mvc.perform(get("/auth/callback").param("code", "c").param("state", state)
				.cookie(new Cookie("sync_login", state))).andExpect(status().isBadRequest());
	}

	private Landing signIn(String uid, String name) throws Exception {
		String verifier = UUID.randomUUID().toString() + "-abcdefgh";
		MockHttpServletResponse start = start(verifier);
		String authorize = start.getRedirectedUrl();
		assertThat(authorize).startsWith(AuthStub.issuer() + "/oauth2/authorize");
		assertThat(param(authorize, "client_id")).isEqualTo(AuthStub.CLIENT_ID);
		String state = param(authorize, "state");
		String code = AuthStub.code(uid, name, param(authorize, "code_challenge"), param(authorize, "redirect_uri"));

		MockHttpServletResponse cb = mvc.perform(get("/auth/callback").param("code", code).param("state", state)
				.cookie(start.getCookie("sync_login"))).andReturn().getResponse();
		assertThat(cb.getRedirectedUrl()).startsWith(EXTENSION + "?handoff=");
		assertThat(cb.getRedirectedUrl()).doesNotContain("eyJ"); // no token in any URL
		return new Landing(UriComponentsBuilder.fromUriString(cb.getRedirectedUrl()).build().getQueryParams().toSingleValueMap(),
				verifier);
	}

	private MockHttpServletResponse start(String verifier) throws Exception {
		MockHttpServletResponse res = mvc.perform(get("/auth/start").param("redirect", EXTENSION)
				.param("challenge", challenge(verifier))).andExpect(status().isFound()).andReturn().getResponse();
		assertThat(param(res.getRedirectedUrl(), "redirect_uri")).isEqualTo(CALLBACK);
		assertThat(res.getCookie("sync_login").isHttpOnly()).isTrue();
		return res;
	}

	private ResultActions handoff(Landing l) throws Exception {
		return call(HttpMethod.POST, "/api/auth/handoff", null, handoffBody(l.params().get("handoff"), l.verifier()));
	}

	private static String challenge(String verifier) {
		return AuthStub.s256(verifier);
	}

	private static String param(String url, String name) {
		return URLDecoder.decode(UriComponentsBuilder.fromUriString(url).build(true).getQueryParams().getFirst(name),
				StandardCharsets.UTF_8);
	}

	private static String handoffBody(String code, String verifier) {
		return "{\"code\":\"" + code + "\",\"verifier\":\"" + verifier + "\"}";
	}

	private static String refreshBody(String token) {
		return "{\"refreshToken\":\"" + token + "\"}";
	}
}
