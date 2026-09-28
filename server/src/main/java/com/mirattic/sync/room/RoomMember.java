package com.mirattic.sync.room;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

/** Membership = permission to join the room. Being live in it is tracked by the socket hub. */
@Entity
@Table(name = "room_members")
@IdClass(RoomMember.Key.class)
public class RoomMember {

	public enum Role {
		HOST, MEMBER
	}

	public record Key(String roomId, String userId) {
	}

	@Id
	private String roomId;
	@Id
	private String userId;
	@Enumerated(EnumType.STRING)
	private Role role;
	private long joinedAt;
	/** Others' messages after this count as unread. */
	private long lastReadAt;
	private boolean muted;

	protected RoomMember() {
	}

	RoomMember(String roomId, String userId, Role role) {
		this.roomId = roomId;
		this.userId = userId;
		this.role = role;
		this.joinedAt = System.currentTimeMillis();
	}

	public String getRoomId() { return roomId; }
	public String getUserId() { return userId; }
	public Role getRole() { return role; }
	public long getLastReadAt() { return lastReadAt; }
	public boolean isMuted() { return muted; }

	void read(long at) { lastReadAt = Math.max(lastReadAt, at); }
	void mute(boolean muted) { this.muted = muted; }
}
