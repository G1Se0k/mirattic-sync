package com.mirattic.sync.auth;

import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * Sign-in through Mirattic Auth for the extension (chrome.identity.launchWebAuthFlow):
 * <pre>
 * /auth/start    ← extension (its redirect URL + a PKCE challenge of its own) → Auth /oauth2/authorize
 * /auth/callback ← Auth (code) → token exchange → &lt;extension redirect&gt;?handoff=&lt;one-time code&gt;
 * /api/auth/handoff ← extension (handoff code + its verifier) → Auth access + refresh token
 * </pre>
 * No token ever appears in a URL. The state is bound to the browser by a cookie (login CSRF), the handoff to the
 * extension instance by its verifier.
 */
@RestController
class MiratticLoginController {

	record HandoffRequest(@NotBlank @Size(max = 128) String code, @NotBlank @Size(max = 128) String verifier) {
	}

	private record Pending(String verifier, String redirect, String challenge) {
	}

	private static final Logger log = LoggerFactory.getLogger(MiratticLoginController.class);
	private static final String COOKIE = "sync_login";
	private static final Duration LOGIN_TTL = Duration.ofMinutes(10);
	private static final Duration HANDOFF_TTL = Duration.ofSeconds(60);

	private final MiratticAuth auth;
	private final UserRepository users;
	private final List<String> extensionRedirects;
	private final boolean secureCookie;
	// ponytail: in memory, so a restart drops logins in progress (they retry) and one instance only.
	private final ShortLived<Pending> pending = new ShortLived<>(LOGIN_TTL);
	private final ShortLived<HandoffEntry> handoffs = new ShortLived<>(HANDOFF_TTL);

	private record HandoffEntry(AuthService.Tokens tokens, String challenge) {
	}

	MiratticLoginController(MiratticAuth auth, UserRepository users,
			@Value("${app.auth.extension-redirects}") List<String> extensionRedirects) {
		this.auth = auth;
		this.users = users;
		this.extensionRedirects = extensionRedirects;
		this.secureCookie = auth.redirectUri.startsWith("https://");
	}

	@GetMapping("/auth/start")
	ResponseEntity<Void> start(@RequestParam String redirect, @RequestParam String challenge) {
		// Only our extension's own redirect: the handoff code must never go anywhere else.
		if (!extensionRedirects.contains(redirect) || !challenge.matches("[A-Za-z0-9_-]{43}")) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "bad login request");
		}
		String state = TokenService.newOpaqueToken();
		String verifier = TokenService.newOpaqueToken();
		pending.put(state, new Pending(verifier, redirect, challenge));
		URI authorize = UriComponentsBuilder.fromUriString(auth.issuer + "/oauth2/authorize")
				.queryParam("response_type", "code")
				.queryParam("client_id", auth.clientId)
				.queryParam("redirect_uri", auth.redirectUri)
				.queryParam("scope", "openid profile email")
				.queryParam("state", state)
				.queryParam("code_challenge", s256(verifier))
				.queryParam("code_challenge_method", "S256")
				.encode().build().toUri();
		return redirect(authorize, cookie(state, LOGIN_TTL));
	}

	@GetMapping("/auth/callback")
	@Transactional
	ResponseEntity<Void> callback(@RequestParam(required = false) String code, @RequestParam(required = false) String state,
			@RequestParam(required = false) String error, @CookieValue(name = COOKIE, required = false) String cookie) {
		Pending p = state == null ? null : pending.take(state);
		if (p == null) {
			// Unknown or expired: there is no extension redirect to report to.
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "login expired, try again");
		}
		String clear = cookie("", Duration.ZERO);
		if (!state.equals(cookie)) {
			return redirect(back(p.redirect(), "error", "state_mismatch"), clear);
		}
		if (error != null || code == null) {
			return redirect(back(p.redirect(), "error", error != null && error.matches("[a-z_]{1,40}") ? error : "failed"), clear);
		}
		AuthService.Tokens tokens;
		try {
			MiratticAuth.TokenResponse t = auth.exchange(code, p.verifier());
			var id = auth.decode(t.id_token());
			// First Auth login of this UID: its Sync profile (product fields only) starts here.
			User user = users.findById(id.getSubject()).orElseGet(() -> users.save(User.fromAuth(id.getSubject(),
					displayName(id.getClaimAsString("name")))));
			tokens = new AuthService.Tokens(t.access_token(), t.refresh_token(), UserSummary.of(user));
		} catch (RuntimeException e) {
			log.warn("Mirattic Auth code exchange failed: {}", e.getClass().getSimpleName());
			return redirect(back(p.redirect(), "error", "exchange_failed"), clear);
		}
		String handoff = TokenService.newOpaqueToken();
		handoffs.put(handoff, new HandoffEntry(tokens, p.challenge()));
		return redirect(back(p.redirect(), "handoff", handoff), clear);
	}

	/** Single use, 60 s, and only with the verifier of the challenge sent to /auth/start. */
	@PostMapping("/api/auth/handoff")
	AuthService.Tokens handoff(@Valid @RequestBody HandoffRequest req) {
		HandoffEntry h = handoffs.take(req.code());
		if (h == null || !MessageDigest.isEqual(h.challenge().getBytes(StandardCharsets.US_ASCII),
				s256(req.verifier()).getBytes(StandardCharsets.US_ASCII))) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid handoff");
		}
		return h.tokens();
	}

	private static String displayName(String name) {
		String n = name == null ? "" : name.strip();
		if (n.isEmpty()) {
			return "Mirattic 사용자";
		}
		return n.length() > 32 ? n.substring(0, 32) : n;
	}

	private static URI back(String redirect, String key, String value) {
		return UriComponentsBuilder.fromUriString(redirect).queryParam(key, value).encode().build().toUri();
	}

	private String cookie(String value, Duration maxAge) {
		return ResponseCookie.from(COOKIE, value).path("/auth/callback").httpOnly(true).secure(secureCookie)
				.sameSite("Lax").maxAge(maxAge).build().toString();
	}

	private static ResponseEntity<Void> redirect(URI to, String cookie) {
		return ResponseEntity.status(HttpStatus.FOUND).location(to).header(HttpHeaders.SET_COOKIE, cookie)
				.header(HttpHeaders.CACHE_CONTROL, "no-store").build();
	}

	static String s256(String verifier) {
		try {
			byte[] hash = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
			return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/** Expiring single-use entries, capped so unauthenticated /auth/start calls can't fill the heap. */
	private static final class ShortLived<V> {
		private record Entry<V>(V value, long expiresAt) {
		}

		private static final int MAX = 10_000;
		private final Map<String, Entry<V>> map = new ConcurrentHashMap<>();
		private final long ttlMillis;

		ShortLived(Duration ttl) {
			this.ttlMillis = ttl.toMillis();
		}

		void put(String key, V value) {
			long now = System.currentTimeMillis();
			if (map.size() >= MAX) {
				map.values().removeIf(e -> e.expiresAt() <= now);
				if (map.size() >= MAX) {
					throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "too many logins in progress");
				}
			}
			map.put(key, new Entry<>(value, now + ttlMillis));
		}

		V take(String key) {
			Entry<V> e = map.remove(key);
			return e == null || e.expiresAt() <= System.currentTimeMillis() ? null : e.value();
		}
	}
}
