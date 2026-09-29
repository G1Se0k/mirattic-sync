package com.mirattic.sync.auth;

import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
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
	NimbusJwtDecoder decoder(OAuth2TokenValidator<Jwt> extra) {
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
	AuthService.Tokens refresh(String refreshToken) {
		MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
		body.add("grant_type", "refresh_token");
		body.add("refresh_token", refreshToken);
		TokenResponse t;
		try {
			t = post("/oauth2/token", body, TokenResponse.class);
		} catch (HttpClientErrorException.BadRequest e) {
			// invalid_grant: expired, revoked, rotated away. Only this means "signed out"; anything else (e.g. a
			// wrong client secret → 401 invalid_client) must not make every client drop its token.
			throw new AuthService.InvalidRefreshToken();
		} catch (RestClientException e) {
			log.warn("Mirattic Auth refresh failed: {}", e.getClass().getSimpleName());
			throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "auth server unavailable");
		}
		// A Sync account deleted meanwhile has no session here any more.
		String sub = decode(t.access_token()).getSubject();
		UserSummary user = users.findById(sub).map(UserSummary::of).orElse(null);
		if (user == null) {
			revoke(t.refresh_token());
			throw new AuthService.InvalidRefreshToken();
		}
		return new AuthService.Tokens(t.access_token(), t.refresh_token(), user);
	}

	/** Revokes the login behind this refresh token at Auth. Best effort, like the legacy logout. */
	void revoke(String refreshToken) {
		MultiValueMap<String, String> body = new LinkedMultiValueMap<>();
		body.add("token", refreshToken);
		body.add("token_type_hint", "refresh_token");
		try {
			post("/oauth2/revoke", body, Void.class);
		} catch (RestClientException e) {
			log.warn("Mirattic Auth revoke failed: {}", e.getClass().getSimpleName());
		}
	}

	private <T> T post(String path, MultiValueMap<String, String> body, Class<T> type) {
		return http.post().uri(path).contentType(MediaType.APPLICATION_FORM_URLENCODED).body(body).retrieve().body(type);
	}

	private static String form(String value) {
		return URLEncoder.encode(value, StandardCharsets.UTF_8);
	}
}
