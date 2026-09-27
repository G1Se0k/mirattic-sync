package com.mirattic.sync;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Shared context (one MySQL container) for all integration tests. Each test uses fresh random users. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.jwt-secret=test-secret-test-secret-test-secret-0123456789",
		"app.auth-rate-limit-per-minute=100000" })
@AutoConfigureMockMvc
public abstract class IntegrationTest {

	protected record TestUser(String id, String email, String friendCode, String accessToken, String refreshToken) {
	}

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
}
