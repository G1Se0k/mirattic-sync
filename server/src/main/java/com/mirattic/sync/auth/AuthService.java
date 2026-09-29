package com.mirattic.sync.auth;

import com.mirattic.sync.user.IdentityProvider;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserIdentity;
import com.mirattic.sync.user.UserIdentityRepository;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import java.util.Locale;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AuthService {

	public record Tokens(String accessToken, String refreshToken, UserSummary user) {
	}

	/** Committed even though it is thrown, so a detected reuse still revokes the family. */
	static class InvalidRefreshToken extends ResponseStatusException {
		InvalidRefreshToken() {
			super(HttpStatus.UNAUTHORIZED, "invalid refresh token");
		}
	}

	private final UserRepository users;
	private final UserIdentityRepository identities;
	private final RefreshTokenRepository refreshTokens;
	private final TokenService tokens;
	private final PasswordEncoder passwordEncoder;
	private final String dummyHash;

	AuthService(UserRepository users, UserIdentityRepository identities, RefreshTokenRepository refreshTokens,
			TokenService tokens, PasswordEncoder passwordEncoder) {
		this.users = users;
		this.identities = identities;
		this.refreshTokens = refreshTokens;
		this.tokens = tokens;
		this.passwordEncoder = passwordEncoder;
		// Compared against when the email is unknown, so login timing doesn't reveal which emails exist.
		this.dummyHash = passwordEncoder.encode(UUID.randomUUID().toString());
	}

	@Transactional
	public Tokens signup(String email, String password, String displayName) {
		String normalized = normalize(email);
		if (identities.existsByProviderAndSubject(IdentityProvider.LOCAL, normalized)) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, "email already registered");
		}
		User user = users.save(new User(displayName.trim()));
		identities.save(UserIdentity.local(user.getId(), normalized, passwordEncoder.encode(password)));
		return issue(user, UUID.randomUUID().toString());
	}

	@Transactional
	public Tokens login(String email, String password) {
		UserIdentity identity = identities.findByProviderAndSubject(IdentityProvider.LOCAL, normalize(email))
				.orElse(null);
		boolean ok = passwordEncoder.matches(password, identity != null ? identity.getPasswordHash() : dummyHash);
		User user = ok && identity != null ? users.findById(identity.getUserId()).orElse(null) : null;
		if (user == null) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid email or password");
		}
		return issue(user, UUID.randomUUID().toString());
	}

	/** A legacy Sync refresh token (dual acceptance); anything else is relayed to Mirattic Auth. */
	public boolean isLegacy(String rawToken) {
		return refreshTokens.existsByTokenHash(TokenService.sha256(rawToken));
	}

	@Transactional(noRollbackFor = InvalidRefreshToken.class)
	public Tokens refresh(String rawToken) {
		long now = System.currentTimeMillis();
		RefreshToken current = refreshTokens.findByTokenHash(TokenService.sha256(rawToken))
				.orElseThrow(InvalidRefreshToken::new);
		if (current.getRevokedAt() != null) {
			// A rotated-away token came back: assume theft and kill every token from that login.
			refreshTokens.revokeFamily(current.getFamilyId(), now);
			throw new InvalidRefreshToken();
		}
		if (current.getExpiresAt() <= now) {
			throw new InvalidRefreshToken();
		}
		current.revoke(now);
		User user = users.findById(current.getUserId()).orElseThrow(InvalidRefreshToken::new);
		return issue(user, current.getFamilyId());
	}

	@Transactional
	public void logout(String rawToken) {
		refreshTokens.findByTokenHash(TokenService.sha256(rawToken))
				.ifPresent(t -> refreshTokens.revokeFamily(t.getFamilyId(), System.currentTimeMillis()));
	}

	private Tokens issue(User user, String familyId) {
		String refresh = TokenService.newOpaqueToken();
		refreshTokens.save(new RefreshToken(user.getId(), familyId, TokenService.sha256(refresh),
				System.currentTimeMillis() + TokenService.REFRESH_TTL.toMillis()));
		return new Tokens(tokens.accessToken(user.getId()), refresh, UserSummary.of(user));
	}

	private static String normalize(String email) {
		return email.trim().toLowerCase(Locale.ROOT);
	}
}
