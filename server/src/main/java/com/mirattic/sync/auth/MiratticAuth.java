package com.mirattic.sync.auth;

import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Mirattic Auth as seen from Sync (docs: Mirattic Auth migration.md, option B). Sync is the confidential
 * client `mirattic-sync`: it alone holds the client secret, exchanges codes, and relays refresh / revoke for the
 * extension, which holds Auth's access and refresh tokens.
 */
@Component
public class MiratticAuth {

	/** Committed as a 401: the client drops its refresh token and signs out. */
	static class InvalidRefreshToken extends ResponseStatusException {
		InvalidRefreshToken() {
			super(HttpStatus.UNAUTHORIZED, "invalid refresh token");
		}
	}

	/** Auth's token endpoint answer. Field names are the OAuth wire names. */
	record TokenResponse(String access_token, String refresh_token, String id_token) {
	}

	private static final Logger log = LoggerFactory.getLogger(MiratticAuth.class);

	final String issuer;
	final String clientId;
	final String redirectUri;
	private final RestClient http;
	private final NimbusJwtDecoder decoder;
	private final UserRepository users;

	MiratticAuth(@Value("${app.auth.issuer}") String issuer, @Value("${app.auth.client-id}") String clientId,
			@Value("${app.auth.client-secret}") String clientSecret, @Value("${app.auth.redirect-uri}") String redirectUri,
			UserRepository users) {
		this.issuer = issuer;
		this.clientId = clientId;
		this.redirectUri = redirectUri;
		this.users = users;
		SimpleClientHttpRequestFactory timeouts = new SimpleClientHttpRequestFactory();
		timeouts.setConnectTimeout(Duration.ofSeconds(5));
		timeouts.setReadTimeout(Duration.ofSeconds(10));
		this.http = RestClient.builder()
				.baseUrl(issuer)
				.requestFactory(timeouts)
				// RFC 6749 2.3.1: id and secret are form-encoded before Basic (a base64 secret has + / =).
				.defaultHeaders(h -> h.setBasicAuth(form(clientId), form(clientSecret)))
				.build();
		this.decoder = decoder(null);
	}

	/**
	 * Signature (Auth JWKS), iss, exp and aud = this client. `extra` adds the API's checks; without it, used for
	 * tokens Sync receives straight from Auth (ID token at the callback, access token of a relayed refresh).
	 */
	public NimbusJwtDecoder decoder(OAuth2TokenValidator<Jwt> extra) {
		NimbusJwtDecoder d = NimbusJwtDecoder.withJwkSetUri(issuer + "/oauth2/jwks").build();
		OAuth2TokenValidator<Jwt> audience = jwt -> jwt.getAudience() != null && jwt.getAudience().contains(clientId)
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "wrong audience", null));
		OAuth2TokenValidator<Jwt> base = new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefaultWithIssuer(issuer),
				audience);
		d.setJwtValidator(extra == null ? base : new DelegatingOAuth2TokenValidator<>(base, extra));
		return d;
	}

	Jwt decode(String token) {
		return decoder.decode(token);
	}

	/** Authorization code + our PKCE verifier → Auth tokens. Throws on any failure (the caller reports it). */
	TokenResponse exchange(String code, String verifier) {
		MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
		body.add("grant_type", "authorization_code");
		body.add("code", code);
		body.add("redirect_uri", redirectUri);
		body.add("code_verifier", verifier);
		return post("/oauth2/token", body, TokenResponse.class);
	}

	/** Rotates the extension's Auth refresh token. 401 when Auth refuses it, so the client signs out. */
	AuthTokens refresh(String refreshToken) {
		MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
		body.add("grant_type", "refresh_token");
		body.add("refresh_token", refreshToken);
		TokenResponse t;
		try {
			t = post("/oauth2/token", body, TokenResponse.class);
		} catch (HttpClientErrorException.BadRequest e) {
			// invalid_grant: expired, revoked, rotated away. Only this means "signed out"; anything else (another
			// 400 such as invalid_request, or a wrong client secret → 401) must not make every client drop its token.
			if (!invalidGrant(e)) {
				log.warn("Mirattic Auth refused the refresh: {}", e.getResponseBodyAsString());
				throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "auth server refused the request");
			}
			throw new InvalidRefreshToken();
		} catch (RestClientException e) {
			log.warn("Mirattic Auth refresh failed: {}", e.getClass().getSimpleName());
			throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "auth server unavailable");
		}
		// A Sync account deleted meanwhile has no session here any more.
		String sub = decode(t.access_token()).getSubject();
		UserSummary user = users.findById(sub).map(UserSummary::of).orElse(null);
		if (user == null) {
			revoke(t.refresh_token());
			throw new InvalidRefreshToken();
		}
		return new AuthTokens(t.access_token(), t.refresh_token(), user);
	}

	/** The account's email and name as Auth's UserInfo has them now (Auth owns both); either null if absent. */
	public record UserInfo(String email, String name) {
	}

	/** Auth's UserInfo for this access token, or null if Auth can't say right now. */
	public UserInfo userInfo(String accessToken) {
		try {
			Map<?, ?> info = http.get().uri("/userinfo").headers(h -> h.setBearerAuth(accessToken)).retrieve().body(Map.class);
			if (info == null) {
				return null;
			}
			return new UserInfo(info.get("email") instanceof String e ? e : null, info.get("name") instanceof String n ? n : null);
		} catch (RestClientException e) {
			log.warn("Mirattic Auth userinfo failed: {}", e.getClass().getSimpleName());
			return null;
		}
	}

	/** Revokes the login behind this refresh token at Auth. Best effort, like the legacy logout. */
	public void revoke(String refreshToken) {
		MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
		body.add("token", refreshToken);
		body.add("token_type_hint", "refresh_token");
		try {
			post("/oauth2/revoke", body, Void.class);
		} catch (RestClientException e) {
			log.warn("Mirattic Auth revoke failed: {}", e.getClass().getSimpleName());
		}
	}

	private static boolean invalidGrant(HttpClientErrorException e) {
		try {
			Map<?, ?> body = e.getResponseBodyAs(Map.class);
			return body != null && "invalid_grant".equals(body.get("error"));
		} catch (RuntimeException unreadable) {
			return false;
		}
	}

	private <T> T post(String path, MultiValueMap<String, String> body, Class<T> type) {
		return http.post().uri(path).contentType(MediaType.APPLICATION_FORM_URLENCODED).body(body).retrieve().body(type);
	}

	private static String form(String value) {
		return URLEncoder.encode(value, StandardCharsets.UTF_8);
	}
}
