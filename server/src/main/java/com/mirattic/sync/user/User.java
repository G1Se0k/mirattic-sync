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
	private String avatarUrl;
	private String friendCode;
	@Enumerated(EnumType.STRING)
	private Visibility presenceVisibility;
	@Enumerated(EnumType.STRING)
	private Visibility positionVisibility;
	/** Friend requests by the code only, none from room members by name (decision 108). */
	private boolean friendCodeOnly;
	/** 오프라인으로 표시 (decision 120): friends see them offline, whatever they do. */
	private boolean appearOffline;
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

	/** A user first seen through Mirattic Auth: the UID is Auth's `sub` (the same UUID for imported accounts). */
	public static User fromAuth(String id, String displayName) {
		User u = new User(displayName);
		u.id = id;
		return u;
	}

	/** Auth's `name` as shown here: trimmed, at most 32 characters, a default when Auth has none. */
	public static String nameFromAuth(String name) {
		String n = name == null ? "" : name.strip();
		if (n.isEmpty()) {
			return "Mirattic 사용자";
		}
		return n.length() > 32 ? n.substring(0, 32) : n;
	}

	/** The name follows Mirattic Auth's (decision 99): Auth owns it, Sync shows it. None (or blank): the kept one stays. True if it changed. */
	public boolean syncName(String authName) {
		if (authName == null || authName.isBlank() || nameFromAuth(authName).equals(displayName)) {
			return false;
		}
		this.displayName = nameFromAuth(authName);
		return true;
	}

	/** The photo follows Mirattic Auth's too: its URL only (checked by MiratticAuth.avatar), none = none. True if it changed. */
	public boolean syncAvatar(String url) {
		if (java.util.Objects.equals(url, avatarUrl)) {
			return false;
		}
		this.avatarUrl = url;
		return true;
	}

	public String getId() { return id; }
	public String getAvatarUrl() { return avatarUrl; }
	public String getDisplayName() { return displayName; }
	public String getFriendCode() { return friendCode; }
	public Visibility getPresenceVisibility() { return presenceVisibility; }
	public Visibility getPositionVisibility() { return positionVisibility; }
	public boolean isFriendCodeOnly() { return friendCodeOnly; }
	public boolean isAppearOffline() { return appearOffline; }
	public void setAppearOffline(boolean appearOffline) { this.appearOffline = appearOffline; }

	/** Invalidates the old code, e.g. after it was shared too widely. */
	public void regenerateFriendCode() {
		this.friendCode = FriendCode.generate();
	}

	public void setPrivacy(Visibility presence, Visibility position) {
		this.presenceVisibility = presence;
		this.positionVisibility = position;
	}

	public void setFriendCodeOnly(boolean codeOnly) {
		this.friendCodeOnly = codeOnly;
	}
}
