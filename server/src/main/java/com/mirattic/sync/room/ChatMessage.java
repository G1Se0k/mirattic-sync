package com.mirattic.sync.room;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "chat_messages")
public class ChatMessage {

	/**
	 * Mirrors `ChatMessage` in packages/types. `kind` null = a message someone wrote; else a room log (decision 78):
	 * "join" / "leave" (text = the name then), "content" (text = the title), "kick" / "host" (text = that member's name),
	 * "stamp" (a member's timestamp, text = their name then). `contentKey`: the video a position belongs to.
	 */
	/** `userName`: a message's author's name now (decision 112), so one who left still shows by name; else null. */
	public record View(String id, String roomId, String userId, String text, Long mediaPositionMs, String kind,
			long createdAt, boolean deleted, String contentKey, String userName) {
		View named(String name) {
			return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, deleted, contentKey, name);
		}
	}

	@Id
	private String id;
	private String roomId;
	private String userId;
	private String text;
	private Long mediaPositionMs;
	private String kind;
	/** "<provider>:<contentId>" of the room's video when written, with a position only. */
	private String contentKey;
	private boolean deleted;
	/** Insert order (AUTO_INCREMENT), for read marks. */
	@Column(insertable = false, updatable = false)
	private long seq;
	private long createdAt;

	protected ChatMessage() {
	}

	ChatMessage(String roomId, String userId, String text, Long mediaPositionMs, String kind) {
		this(roomId, userId, text, mediaPositionMs, kind, null);
	}

	/** `room`'s video is what the position belongs to (none without a position). */
	ChatMessage(String roomId, String userId, String text, Long mediaPositionMs, String kind, Room room) {
		this.id = UUID.randomUUID().toString();
		this.roomId = roomId;
		this.userId = userId;
		this.text = text;
		this.mediaPositionMs = mediaPositionMs;
		this.kind = kind;
		this.contentKey = mediaPositionMs == null || room == null ? null : room.contentKey();
		this.createdAt = System.currentTimeMillis();
	}

	View view() {
		return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, deleted, contentKey, null);
	}

	/** A "content" line: about `room`'s video now (which video it names, for its title read late). */
	ChatMessage about(Room room) {
		this.contentKey = room.contentKey();
		return this;
	}

	/** A "content" line: the title read late. */
	ChatMessage retitle(String title) {
		this.text = title;
		return this;
	}

	/** Deleted for everyone: the text is gone, a placeholder keeps its place in the chat. */
	void delete() {
		this.deleted = true;
		this.text = "";
		this.mediaPositionMs = null;
		this.contentKey = null;
	}

	boolean isLog() {
		return kind != null;
	}

	boolean isDeleted() {
		return deleted;
	}
}
