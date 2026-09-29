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
 * Fixed one-minute window per client IP on /api/auth/**, /auth/** (Mirattic Auth sign-in) and DELETE /api/me (password brute-force guard).
 * ponytail: in-memory and uses the socket address; behind a proxy, trust X-Forwarded-For via
 * server.forward-headers-strategy, and move counters to Redis when running more than one instance.
 */
@Component
class AuthRateLimitFilter extends OncePerRequestFilter {

	private record Window(long minute, int count) {
	}

	private final Map<String, Window> windows = new ConcurrentHashMap<>();
	private final int limitPerMinute;

	AuthRateLimitFilter(@Value("${app.auth-rate-limit-per-minute}") int limitPerMinute) {
		this.limitPerMinute = limitPerMinute;
	}

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		// Account deletion checks a password too.
		return !request.getRequestURI().startsWith("/api/auth/") && !request.getRequestURI().startsWith("/auth/")
				&& !("DELETE".equals(request.getMethod()) && "/api/me".equals(request.getRequestURI()));
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		long minute = System.currentTimeMillis() / 60_000;
		if (windows.size() > 10_000) {
			windows.values().removeIf(w -> w.minute() < minute);
		}
		Window w = windows.merge(request.getRemoteAddr(), new Window(minute, 1),
				(old, one) -> old.minute() == minute ? new Window(minute, old.count() + 1) : one);
		if (w.count() > limitPerMinute) {
			response.setStatus(429);
			response.setHeader("Retry-After", "60");
			return;
		}
		chain.doFilter(request, response);
	}
}
