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
	 * "join" / "leave" (text = the name then), "play" / "pause" / "seek" by the host, "content" (text = the title).
	 */
	public record View(String id, String roomId, String userId, String text, Long mediaPositionMs, String kind,
			long createdAt, boolean deleted) {
	}

	@Id
	private String id;
	private String roomId;
	private String userId;
	private String text;
	private Long mediaPositionMs;
	private String kind;
	private boolean deleted;
	/** Insert order (AUTO_INCREMENT), for read marks. */
	@Column(insertable = false, updatable = false)
	private long seq;
	private long createdAt;

	protected ChatMessage() {
	}

	ChatMessage(String roomId, String userId, String text, Long mediaPositionMs, String kind) {
		this.id = UUID.randomUUID().toString();
		this.roomId = roomId;
		this.userId = userId;
		this.text = text;
		this.mediaPositionMs = mediaPositionMs;
		this.kind = kind;
		this.createdAt = System.currentTimeMillis();
	}

	View view() {
		return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, deleted);
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
	}

	boolean isLog() {
		return kind != null;
	}

	boolean isDeleted() {
		return deleted;
	}
}
