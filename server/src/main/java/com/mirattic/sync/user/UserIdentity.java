package com.mirattic.sync.user;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

/**
 * One way to sign in to a user. A user has one or more identities; (provider, subject) is globally unique.
 * The user's UID never depends on an identity, so identities can be added, removed or re-linked.
 */
@Entity
@Table(name = "user_identities")
public class UserIdentity {

	@Id
	private String id;
	private String userId;
	@Enumerated(EnumType.STRING)
	private IdentityProvider provider;
	private String subject;
	private String email;
	private String passwordHash;
	private long createdAt;

	protected UserIdentity() {
	}

	private UserIdentity(String userId, IdentityProvider provider, String subject, String email, String passwordHash) {
		this.id = UUID.randomUUID().toString();
		this.userId = userId;
		this.provider = provider;
		this.subject = subject;
		this.email = email;
		this.passwordHash = passwordHash;
		this.createdAt = System.currentTimeMillis();
	}

	/** Email + password. The normalized email is both the subject and the contact email. */
	public static UserIdentity local(String userId, String normalizedEmail, String passwordHash) {
		return new UserIdentity(userId, IdentityProvider.LOCAL, normalizedEmail, normalizedEmail, passwordHash);
	}

	public String getUserId() { return userId; }
	public IdentityProvider getProvider() { return provider; }
	public String getEmail() { return email; }
	public String getPasswordHash() { return passwordHash; }
}
