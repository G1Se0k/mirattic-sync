package com.mirattic.sync.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Fixed one-minute window per client IP on /api/auth/** and /auth/** (sign-in and token relay to Mirattic Auth) and
 * DELETE /api/me (account deletion), and the invitation preview /api/invite/** and page /r/** (open to anyone, so a
 * code can't be found by trying). Past the limit the page still opens, marked {@link #LIMITED}: it shows no room.
 * Invitations count apart from sign-in, so opening many links never blocks signing in from that IP.
 * ponytail: in-memory and uses the socket address; behind a proxy, trust X-Forwarded-For via
 * server.forward-headers-strategy, and move counters to Redis when running more than one instance.
 */
@Component
public class AuthRateLimitFilter extends OncePerRequestFilter {

	/** Request attribute on an invitation page past the limit. */
	public static final String LIMITED = AuthRateLimitFilter.class.getName() + ".limited";

	private record Window(long minute, int count) {
	}

	private final Map<String, Window> windows = new ConcurrentHashMap<>();
	private final int limitPerMinute;

	AuthRateLimitFilter(@Value("${app.auth-rate-limit-per-minute}") int limitPerMinute) {
		this.limitPerMinute = limitPerMinute;
	}

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		return !request.getRequestURI().startsWith("/api/auth/") && !request.getRequestURI().startsWith("/auth/")
				&& !request.getRequestURI().startsWith("/api/invite/") && !request.getRequestURI().startsWith("/r/")
				&& !("DELETE".equals(request.getMethod()) && "/api/me".equals(request.getRequestURI()));
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		long minute = System.currentTimeMillis() / 60_000;
		if (windows.size() > 10_000) {
			windows.values().removeIf(w -> w.minute() < minute);
		}
		boolean invitation = request.getRequestURI().startsWith("/r/") || request.getRequestURI().startsWith("/api/invite/");
		Window w = windows.merge((invitation ? "invite " : "auth ") + request.getRemoteAddr(), new Window(minute, 1),
				(old, one) -> old.minute() == minute ? new Window(minute, old.count() + 1) : one);
		if (w.count() > limitPerMinute) {
			if (request.getRequestURI().startsWith("/r/")) {
				request.setAttribute(LIMITED, true);
			} else {
				response.setStatus(429);
				response.setHeader("Retry-After", "60");
				return;
			}
		}
		chain.doFilter(request, response);
	}
}
