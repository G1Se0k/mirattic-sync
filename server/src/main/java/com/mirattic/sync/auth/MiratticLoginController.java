package com.mirattic.sync.auth;

import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.Jwt;
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
 * extension instance by its verifier. `reauth=true` asks Auth for the password again (`prompt=login`), for account
 * deletion.
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

	private final MiratticAuth auth;
	private final Handoffs handoffs;
	private final UserRepository users;
	private final List<String> extensionRedirects;
	private final boolean secureCookie;
	private final ShortLived<Pending> pending = new ShortLived<>(LOGIN_TTL);

	MiratticLoginController(MiratticAuth auth, Handoffs handoffs, UserRepository users,
			@Value("${app.auth.extension-redirects}") List<String> extensionRedirects) {
		this.auth = auth;
		this.handoffs = handoffs;
		this.users = users;
		this.extensionRedirects = extensionRedirects;
		this.secureCookie = auth.redirectUri.startsWith("https://");
	}

	@GetMapping("/auth/start")
	ResponseEntity<Void> start(@RequestParam String redirect, @RequestParam String challenge,
			@RequestParam(defaultValue = "false") boolean reauth) {
		// Only our extension's own redirect: the handoff code must never go anywhere else.
		if (!extensionRedirects.contains(redirect) || !challenge.matches("[A-Za-z0-9_-]{43}")) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "bad login request");
		}
		String state = TokenService.newOpaqueToken();
		String verifier = TokenService.newOpaqueToken();
		pending.put(state, new Pending(verifier, redirect, challenge));
		UriComponentsBuilder authorize = UriComponentsBuilder.fromUriString(auth.issuer + "/oauth2/authorize")
				.queryParam("response_type", "code")
				.queryParam("client_id", auth.clientId)
				.queryParam("redirect_uri", auth.redirectUri)
				.queryParam("scope", "openid profile email")
				.queryParam("state", state)
				.queryParam("code_challenge", Handoffs.s256(verifier))
				.queryParam("code_challenge_method", "S256");
		if (reauth) {
			authorize.queryParam("prompt", "login");
		}
		return redirect(authorize.encode().build().toUri(), cookie(state, LOGIN_TTL));
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
		Handoffs.Handoff handoff;
		try {
			MiratticAuth.TokenResponse t = auth.exchange(code, p.verifier());
			Jwt id = auth.decode(t.id_token());
			// First Auth login of this UID: its Sync profile (product fields only) starts here. Every login: the name as
			// Auth has it now (decision 99).
			String name = id.getClaimAsString("name");
			User user = users.findById(id.getSubject()).orElseGet(() -> User.fromAuth(id.getSubject(), User.nameFromAuth(name)));
			user.syncName(name); // no name in the token: the one kept stays
			user = users.save(user);
			Instant authTime = id.hasClaim("auth_time") ? id.getClaimAsInstant("auth_time") : Instant.EPOCH;
			handoff = new Handoffs.Handoff(new AuthTokens(t.access_token(), t.refresh_token(), UserSummary.of(user)), authTime);
		} catch (RuntimeException e) {
			log.warn("Mirattic Auth code exchange failed: {}", e.getClass().getSimpleName());
			return redirect(back(p.redirect(), "error", "exchange_failed"), clear);
		}
		return redirect(back(p.redirect(), "handoff", handoffs.put(handoff, p.challenge())), clear);
	}

	@PostMapping("/api/auth/handoff")
	AuthTokens handoff(@Valid @RequestBody HandoffRequest req) {
		Handoffs.Handoff h = handoffs.redeem(req.code(), req.verifier());
		if (h == null) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid handoff");
		}
		return h.tokens();
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
}
