package com.mirattic.sync.auth;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "refresh_tokens")
public class RefreshToken {

	@Id
	private String id;
	private String userId;
	/** All tokens rotated from one login share a family; reuse of a revoked token revokes the family. */
	private String familyId;
	private String tokenHash;
	private long expiresAt;
	private Long revokedAt;

	protected RefreshToken() {
	}

	RefreshToken(String userId, String familyId, String tokenHash, long expiresAt) {
		this.id = UUID.randomUUID().toString();
		this.userId = userId;
		this.familyId = familyId;
		this.tokenHash = tokenHash;
		this.expiresAt = expiresAt;
	}

	String getUserId() { return userId; }
	String getFamilyId() { return familyId; }
	long getExpiresAt() { return expiresAt; }
	Long getRevokedAt() { return revokedAt; }

	void revoke(long now) {
		this.revokedAt = now;
	}
}
