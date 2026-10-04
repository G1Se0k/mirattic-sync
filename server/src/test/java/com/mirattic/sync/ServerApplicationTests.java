package com.mirattic.sync;

import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;

class ServerApplicationTests extends IntegrationTest {

	@Test
	void healthIsPublic() throws Exception {
		call(HttpMethod.GET, "/actuator/health", null, null).andExpect(status().isOk());
	}

	@Test
	void privacyPolicyAndPatchNotesArePublic() throws Exception {
		call(HttpMethod.GET, "/privacy.html", null, null).andExpect(status().isOk());
		call(HttpMethod.GET, "/patch-notes.html", null, null).andExpect(status().isOk());
	}

	@Test
	void theHomePageAndItsImagesArePublic() throws Exception {
		call(HttpMethod.GET, "/", null, null).andExpect(status().isOk());
		call(HttpMethod.GET, "/landing/logo.png", null, null).andExpect(status().isOk());
		call(HttpMethod.GET, "/landing/1-watch-together.jpg", null, null).andExpect(status().isOk());
	}

	@Test
	void apiRequiresAuthentication() throws Exception {
		call(HttpMethod.GET, "/api/me", null, null).andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", "not-a-jwt", null).andExpect(status().isUnauthorized());
	}
}
