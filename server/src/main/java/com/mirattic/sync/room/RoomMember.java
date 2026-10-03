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
	/** Others' messages with a higher `seq` count as unread. */
	private long lastReadSeq;
	private boolean muted;
	/** The room type version they have seen (confirmed, or joined at; decision 93): a higher one is asked about. */
	private long typeSeenVersion;

	protected RoomMember() {
	}

	RoomMember(String roomId, String userId, Role role) {
		this(roomId, userId, role, 0);
	}

	/** `typeSeen`: the room's type version when they join (they come in knowing it). */
	RoomMember(String roomId, String userId, Role role, long typeSeen) {
		this.roomId = roomId;
		this.userId = userId;
		this.role = role;
		this.joinedAt = System.currentTimeMillis();
		this.typeSeenVersion = typeSeen;
	}

	public String getRoomId() { return roomId; }
	public String getUserId() { return userId; }
	public Role getRole() { return role; }
	public long getLastReadSeq() { return lastReadSeq; }
	public boolean isMuted() { return muted; }
	public long getTypeSeenVersion() { return typeSeenVersion; }

	void read(long seq) { lastReadSeq = Math.max(lastReadSeq, seq); }
	void mute(boolean muted) { this.muted = muted; }
	void role(Role role) { this.role = role; }
}
