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
	private String displayName;
	private String friendCode;
	@Enumerated(EnumType.STRING)
	private Visibility presenceVisibility;
	@Enumerated(EnumType.STRING)
	private Visibility positionVisibility;
	private long createdAt;

	protected User() {
	}

	/** The UID is generated here and never derived from an email or provider id. */
	public User(String displayName) {
		this.id = UUID.randomUUID().toString();
		this.friendCode = FriendCode.generate();
		this.displayName = displayName;
		// Private by default: friends see title-level activity, exact position only inside a room.
		this.presenceVisibility = Visibility.FRIENDS;
		this.positionVisibility = Visibility.ROOM_ONLY;
		this.createdAt = System.currentTimeMillis();
	}

	public String getId() { return id; }
	public String getDisplayName() { return displayName; }
	public String getFriendCode() { return friendCode; }
	public Visibility getPresenceVisibility() { return presenceVisibility; }
	public Visibility getPositionVisibility() { return positionVisibility; }

	/** Invalidates the old code, e.g. after it was shared too widely. */
	public void regenerateFriendCode() {
		this.friendCode = FriendCode.generate();
	}

	public void setPrivacy(Visibility presence, Visibility position) {
		this.presenceVisibility = presence;
		this.positionVisibility = position;
	}
}
