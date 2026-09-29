package com.mirattic.sync.auth;

import com.mirattic.sync.user.UserRepository;
import com.nimbusds.jose.JWSObject;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.text.ParseException;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

@Configuration
public class TokenService {

	static final String ISSUER = "mirattic";
	static final Duration ACCESS_TTL = Duration.ofMinutes(15);
	static final Duration REFRESH_TTL = Duration.ofDays(30);

	private static final SecureRandom RANDOM = new SecureRandom();

	private final SecretKey key;
	private final JwtEncoder encoder;

	TokenService(@Value("${app.jwt-secret}") String secret) {
		byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
		if (bytes.length < 32) {
			throw new IllegalStateException("app.jwt-secret (JWT_SECRET) must be at least 32 bytes");
		}
		this.key = new SecretKeySpec(bytes, "HmacSHA256");
		this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key));
	}

	/**
	 * Dual acceptance (migration phase B): legacy Sync tokens (HS256, iss `mirattic`) and Mirattic Auth access
	 * tokens (RS256 via Auth's JWKS, iss = Auth, aud = mirattic-sync). Both carry the UID as `sub`. Picked by the
	 * header's alg; each decoder accepts only its own algorithm and key.
	 */
	@Bean
	JwtDecoder jwtDecoder(UserRepository users, MiratticAuth auth) {
		// A deleted account's access tokens stop working at once, not at expiry.
		// ponytail: one primary-key lookup per request; cache briefly if it ever shows up in profiles.
		OAuth2TokenValidator<Jwt> accountExists = jwt -> users.existsById(jwt.getSubject())
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "account deleted", null));
		NimbusJwtDecoder legacy = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
		legacy.setJwtValidator(new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefaultWithIssuer(ISSUER),
				accountExists));
		// Access tokens only: Auth's ID token (same key, iss and aud) has no `scope` claim.
		OAuth2TokenValidator<Jwt> accessToken = jwt -> jwt.hasClaim("scope")
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "not an access token", null));
		JwtDecoder mirattic = auth.decoder(new DelegatingOAuth2TokenValidator<>(accessToken, accountExists));
		return token -> {
			String alg;
			try {
				alg = JWSObject.parse(token).getHeader().getAlgorithm().getName();
			} catch (ParseException e) {
				throw new BadJwtException("malformed token", e);
			}
			return "HS256".equals(alg) ? legacy.decode(token) : mirattic.decode(token);
		};
	}

	String accessToken(String userId) {
		Instant now = Instant.now();
		JwtClaimsSet claims = JwtClaimsSet.builder()
				.issuer(ISSUER)
				.subject(userId)
				.issuedAt(now)
				.expiresAt(now.plus(ACCESS_TTL))
				.build();
		return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
				.getTokenValue();
	}

	/** Opaque random token; only its SHA-256 is stored. */
	static String newOpaqueToken() {
		byte[] bytes = new byte[32];
		RANDOM.nextBytes(bytes);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
	}

	static String sha256(String value) {
		try {
			return HexFormat.of().formatHex(
					MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
