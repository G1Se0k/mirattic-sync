package com.mirattic.sync.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/** Decision 113: past the limit, an invitation page still opens (marked, so it shows no room); the API is refused. */
class AuthRateLimitFilterTest {

	@Test
	void pastTheLimitThePageOpensWithoutItsRoomAndThePreviewIsRefused() throws Exception {
		AuthRateLimitFilter filter = new AuthRateLimitFilter(1);
		MockHttpServletRequest first = new MockHttpServletRequest("GET", "/r/K7QM4XPR");
		filter.doFilter(first, new MockHttpServletResponse(), new MockFilterChain());
		assertThat(first.getAttribute(AuthRateLimitFilter.LIMITED)).isNull();

		MockHttpServletRequest page = new MockHttpServletRequest("GET", "/r/K7QM4XPR");
		MockFilterChain pageChain = new MockFilterChain();
		filter.doFilter(page, new MockHttpServletResponse(), pageChain);
		assertThat(page.getAttribute(AuthRateLimitFilter.LIMITED)).isEqualTo(true);
		assertThat(pageChain.getRequest()).isNotNull(); // went on

		MockHttpServletResponse api = new MockHttpServletResponse();
		MockFilterChain apiChain = new MockFilterChain();
		filter.doFilter(new MockHttpServletRequest("GET", "/api/invite/K7QM4XPR"), api, apiChain);
		assertThat(api.getStatus()).isEqualTo(429);
		assertThat(apiChain.getRequest()).isNull();
	}

	@Test
	void invitationsAndSignInCountApart() throws Exception {
		AuthRateLimitFilter filter = new AuthRateLimitFilter(1);
		filter.doFilter(new MockHttpServletRequest("GET", "/r/K7QM4XPR"), new MockHttpServletResponse(), new MockFilterChain());
		filter.doFilter(new MockHttpServletRequest("GET", "/api/invite/K7QM4XPR"), new MockHttpServletResponse(), new MockFilterChain());
		MockHttpServletResponse signIn = new MockHttpServletResponse();
		MockFilterChain chain = new MockFilterChain();
		filter.doFilter(new MockHttpServletRequest("GET", "/auth/start"), signIn, chain);
		assertThat(signIn.getStatus()).isEqualTo(200);
		assertThat(chain.getRequest()).isNotNull();
	}
}
