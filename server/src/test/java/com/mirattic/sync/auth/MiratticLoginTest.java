package com.mirattic.sync.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.AuthStub;
import com.mirattic.sync.IntegrationTest;
import jakarta.servlet.http.Cookie;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;

class MiratticLoginTest extends IntegrationTest {

	@Test
	void firstLoginCreatesTheSyncProfileAndHandsOffAuthTokens() throws Exception {
		String uid = UUID.randomUUID().toString();
		JsonNode tokens = body(redeem(signIn(uid, "Alice", false, Instant.now())).andExpect(status().isOk()));
		assertThat(tokens.path("user").path("id").asString()).isEqualTo(uid);

		String access = tokens.path("accessToken").asString();
		call(HttpMethod.GET, "/api/me", access, null)
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.id").value(uid))
				.andExpect(jsonPath("$.email").value(AuthStub.email(uid))) // live from Auth UserInfo
				.andExpect(jsonPath("$.displayName").value("Alice"))
				.andExpect(jsonPath("$.presenceVisibility").value("FRIENDS"))
				.andExpect(jsonPath("$.positionVisibility").value("ROOM_ONLY"))
				.andExpect(jsonPath("$.friendCode").exists());
		call(HttpMethod.POST, "/api/ws-ticket", access, null).andExpect(status().isOk());

		// Second login of the same UID: same profile, not a new one.
		JsonNode again = body(redeem(signIn(uid, "Renamed", false, Instant.now())).andExpect(status().isOk()));
		assertThat(again.path("user").path("displayName").asString()).isEqualTo("Alice");
	}

	@Test
	void handoffIsSingleUseAndBoundToTheExtensionVerifier() throws Exception {
		Handoff h = signIn(UUID.randomUUID().toString(), "Bob", false, Instant.now());
		// A wrong verifier burns the code.
		redeem(new Handoff(h.code(), "x".repeat(43))).andExpect(status().isUnauthorized());
		redeem(h).andExpect(status().isUnauthorized());

		Handoff other = signIn(UUID.randomUUID().toString(), "Bob", false, Instant.now());
		redeem(other).andExpect(status().isOk());
		redeem(other).andExpect(status().isUnauthorized());
	}

	@Test
	void refreshAndLogoutAreRelayedToAuth() throws Exception {
		String refresh = signup().refreshToken();
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
	void anotherAuthErrorIsNotASignOut() throws Exception {
		call(HttpMethod.POST, "/api/auth/refresh", null, refreshBody(AuthStub.INVALID_REQUEST))
				.andExpect(status().isBadGateway());
	}

	@Test
	void onlyAuthAccessTokensForThisClientAreAccepted() throws Exception {
		String uid = signup().id();
		call(HttpMethod.GET, "/api/me", AuthStub.accessToken(uid), null).andExpect(status().isOk());
		// Flow's token, an ID token (no scope), an unknown UID, garbage.
		call(HttpMethod.GET, "/api/me", AuthStub.sign(Map.of("sub", uid, "aud", "mirattic-flow", "scope", "openid")), null)
				.andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", AuthStub.sign(Map.of("sub", uid, "aud", AuthStub.CLIENT_ID)), null)
				.andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", AuthStub.accessToken(UUID.randomUUID().toString()), null)
				.andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", "not-a-jwt", null).andExpect(status().isUnauthorized());
	}

	@Test
	void legacySyncEndpointsAreGone() throws Exception {
		call(HttpMethod.POST, "/api/auth/signup", null, "{\"email\":\"a@b.c\",\"password\":\"password123\",\"displayName\":\"x\"}")
				.andExpect(status().is4xxClientError());
		call(HttpMethod.POST, "/api/auth/login", null, "{\"email\":\"a@b.c\",\"password\":\"password123\"}")
				.andExpect(status().is4xxClientError());
	}

	@Test
	void startAcceptsOnlyOurExtensionAndCallbackNeedsTheBrowserCookie() throws Exception {
		mvc.perform(get("/auth/start").param("redirect", "https://evil.example/").param("challenge", AuthStub.s256("v".repeat(43))))
				.andExpect(status().isBadRequest());

		MockHttpServletResponse start = start("w".repeat(43), false);
		String state = param(start.getRedirectedUrl(), "state");
		// Someone else's browser (no cookie): login CSRF refused, reported to the extension.
		MockHttpServletResponse cb = mvc.perform(get("/auth/callback").param("code", "c").param("state", state))
				.andReturn().getResponse();
		assertThat(cb.getRedirectedUrl()).startsWith(EXTENSION).contains("error=state_mismatch");
		// The state is single use.
		mvc.perform(get("/auth/callback").param("code", "c").param("state", state)
				.cookie(new Cookie("sync_login", state))).andExpect(status().isBadRequest());
	}

	private static String refreshBody(String token) {
		return "{\"refreshToken\":\"" + token + "\"}";
	}
}
