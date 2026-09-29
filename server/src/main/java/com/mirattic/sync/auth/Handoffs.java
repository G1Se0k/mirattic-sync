package com.mirattic.sync.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import org.springframework.stereotype.Component;

/**
 * One-time codes that hand a finished Mirattic sign-in to the extension instance that started it: 60 s, single use,
 * redeemable only with the verifier of the PKCE challenge sent to /auth/start.
 */
@Component
public class Handoffs {

	/** `authTime`: when the user last typed their password at Auth (ID token `auth_time`). */
	public record Handoff(AuthTokens tokens, Instant authTime) {
	}

	private record Entry(Handoff handoff, String challenge) {
	}

	private final ShortLived<Entry> entries = new ShortLived<>(Duration.ofSeconds(60));

	String put(Handoff handoff, String challenge) {
		String code = TokenService.newOpaqueToken();
		entries.put(code, new Entry(handoff, challenge));
		return code;
	}

	/** Null when unknown, expired, used, or the verifier doesn't match (which also burns the code). */
	public Handoff redeem(String code, String verifier) {
		Entry e = entries.take(code);
		return e != null && MessageDigest.isEqual(e.challenge().getBytes(StandardCharsets.US_ASCII),
				s256(verifier).getBytes(StandardCharsets.US_ASCII)) ? e.handoff() : null;
	}

	static String s256(String verifier) {
		try {
			byte[] hash = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
			return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
