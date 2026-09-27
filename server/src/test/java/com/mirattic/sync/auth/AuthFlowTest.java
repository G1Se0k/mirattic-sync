package com.mirattic.sync.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import tools.jackson.databind.JsonNode;

class AuthFlowTest extends IntegrationTest {

	@Test
	void signupThenMeUsesPrivateDefaults() throws Exception {
		TestUser u = signup();
		// The UID is its own UUID, independent of the email identity used to sign in.
		assertThat(java.util.UUID.fromString(u.id()).toString()).isEqualTo(u.id());
		call(HttpMethod.GET, "/api/me", u.accessToken(), null)
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.id").value(u.id()))
				.andExpect(jsonPath("$.email").value(u.email()))
				.andExpect(jsonPath("$.providers[0]").value("LOCAL"))
				.andExpect(jsonPath("$.presenceVisibility").value("FRIENDS"))
				.andExpect(jsonPath("$.positionVisibility").value("ROOM_ONLY"));
	}

	@Test
	void duplicateEmailIsRejectedCaseInsensitively() throws Exception {
		TestUser u = signup();
		call(HttpMethod.POST, "/api/auth/signup", null,
				"{\"email\":\"" + u.email().toUpperCase() + "\",\"password\":\"password123\",\"displayName\":\"x\"}")
				.andExpect(status().isConflict());
	}

	@Test
	void loginChecksPassword() throws Exception {
		TestUser u = signup();
		call(HttpMethod.POST, "/api/auth/login", null, login(u.email(), "wrong-password"))
				.andExpect(status().isUnauthorized());
		call(HttpMethod.POST, "/api/auth/login", null, login("nobody@example.com", "password123"))
				.andExpect(status().isUnauthorized());
		call(HttpMethod.POST, "/api/auth/login", null, login(u.email(), "password123"))
				.andExpect(status().isOk());
	}

	@Test
	void refreshRotatesAndReuseRevokesTheWholeFamily() throws Exception {
		TestUser u = signup();
		JsonNode first = body(call(HttpMethod.POST, "/api/auth/refresh", null, refresh(u.refreshToken()))
				.andExpect(status().isOk()));
		String rotated = first.path("refreshToken").asString();
		assertThat(rotated).isNotEqualTo(u.refreshToken());

		// Old token replayed (e.g. stolen): rejected, and the legitimately rotated token dies with it.
		call(HttpMethod.POST, "/api/auth/refresh", null, refresh(u.refreshToken())).andExpect(status().isUnauthorized());
		call(HttpMethod.POST, "/api/auth/refresh", null, refresh(rotated)).andExpect(status().isUnauthorized());

		// Other logins are unaffected.
		call(HttpMethod.POST, "/api/auth/login", null, login(u.email(), "password123")).andExpect(status().isOk());
	}

	@Test
	void logoutRevokesRefreshToken() throws Exception {
		TestUser u = signup();
		call(HttpMethod.POST, "/api/auth/logout", null, refresh(u.refreshToken())).andExpect(status().isNoContent());
		call(HttpMethod.POST, "/api/auth/refresh", null, refresh(u.refreshToken())).andExpect(status().isUnauthorized());
	}

	@Test
	void signupValidatesInput() throws Exception {
		call(HttpMethod.POST, "/api/auth/signup", null,
				"{\"email\":\"not-an-email\",\"password\":\"short\",\"displayName\":\"\"}")
				.andExpect(status().isBadRequest());
	}

	private static String login(String email, String password) {
		return "{\"email\":\"" + email + "\",\"password\":\"" + password + "\"}";
	}

	private static String refresh(String token) {
		return "{\"refreshToken\":\"" + token + "\"}";
	}
}
