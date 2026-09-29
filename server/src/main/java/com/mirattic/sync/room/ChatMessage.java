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
			long createdAt, Long editedAt, boolean deleted) {
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
	private Long editedAt;

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
		return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, editedAt, deleted);
	}

	/** Deleted for everyone: the text is gone, a placeholder keeps its place in the chat. */
	void delete() {
		this.deleted = true;
		this.text = "";
		this.mediaPositionMs = null;
	}

	/** A seek right after another seek by the same host moves that line instead of adding one. */
	void moveTo(Long mediaPositionMs) {
		this.mediaPositionMs = mediaPositionMs;
		// Strictly increasing, so two moves in one millisecond still order.
		this.editedAt = Math.max(System.currentTimeMillis(), editedAt == null ? 0 : editedAt + 1);
	}

	boolean isLog() {
		return kind != null;
	}

	boolean isDeleted() {
		return deleted;
	}
}
