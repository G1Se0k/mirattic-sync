package com.mirattic.sync.auth;

import com.mirattic.sync.user.UserRepository;
import java.security.SecureRandom;
import java.util.Base64;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

@Configuration
public class TokenService {

	private static final SecureRandom RANDOM = new SecureRandom();

	/**
	 * API bearer tokens are Mirattic Auth access tokens only: RS256 via Auth's JWKS, iss = Auth, aud =
	 * mirattic-sync, `sub` = UID. Sync issues no tokens of its own.
	 */
	@Bean
	JwtDecoder jwtDecoder(UserRepository users, MiratticAuth auth) {
		// A deleted Sync account's access tokens stop working at once, not at expiry.
		// ponytail: one primary-key lookup per request; cache briefly if it ever shows up in profiles.
		OAuth2TokenValidator<Jwt> accountExists = jwt -> users.existsById(jwt.getSubject())
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "account deleted", null));
		// Access tokens only: Auth's ID token (same key, iss and aud) has no `scope` claim, a deletion order a `purpose`.
		OAuth2TokenValidator<Jwt> accessToken = jwt -> jwt.hasClaim("scope") && !jwt.hasClaim("purpose")
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "not an access token", null));
		return auth.decoder(new DelegatingOAuth2TokenValidator<>(accessToken, accountExists));
	}

	/** Opaque random value (state, verifier, handoff code): 32 bytes, base64url, 43 characters. */
	static String newOpaqueToken() {
		byte[] bytes = new byte[32];
		RANDOM.nextBytes(bytes);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
	}
}
