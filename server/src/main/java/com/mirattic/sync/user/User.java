package com.mirattic.sync.user;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "users")
public class User {

	@Id
	private String id;
	private String email;
	private String passwordHash;
	private String displayName;
	@Enumerated(EnumType.STRING)
	private Visibility presenceVisibility;
	@Enumerated(EnumType.STRING)
	private Visibility positionVisibility;
	private long createdAt;

	protected User() {
	}

	public User(String email, String passwordHash, String displayName) {
		this.id = UUID.randomUUID().toString();
		this.email = email;
		this.passwordHash = passwordHash;
		this.displayName = displayName;
		// Private by default: friends see title-level activity, exact position only inside a room.
		this.presenceVisibility = Visibility.FRIENDS;
		this.positionVisibility = Visibility.ROOM_ONLY;
		this.createdAt = System.currentTimeMillis();
	}

	public String getId() { return id; }
	public String getEmail() { return email; }
	public String getPasswordHash() { return passwordHash; }
	public String getDisplayName() { return displayName; }
	public Visibility getPresenceVisibility() { return presenceVisibility; }
	public Visibility getPositionVisibility() { return positionVisibility; }

	public void setPrivacy(Visibility presence, Visibility position) {
		this.presenceVisibility = presence;
		this.positionVisibility = position;
	}
}
