package com.mirattic.sync.room;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "chat_messages")
public class ChatMessage {

	/** Mirrors `ChatMessage` in packages/types. A reaction's text is its emoji. */
	public record View(String id, String roomId, String userId, String text, Long mediaPositionMs, boolean reaction,
			long createdAt, boolean deleted) {
	}

	@Id
	private String id;
	private String roomId;
	private String userId;
	private String text;
	private Long mediaPositionMs;
	private boolean reaction;
	private boolean deleted;
	/** Insert order (AUTO_INCREMENT), for read marks. */
	@Column(insertable = false, updatable = false)
	private long seq;
	private long createdAt;

	protected ChatMessage() {
	}

	ChatMessage(String roomId, String userId, String text, Long mediaPositionMs, boolean reaction) {
		this.id = UUID.randomUUID().toString();
		this.roomId = roomId;
		this.userId = userId;
		this.text = text;
		this.mediaPositionMs = mediaPositionMs;
		this.reaction = reaction;
		this.createdAt = System.currentTimeMillis();
	}

	View view() {
		return new View(id, roomId, userId, text, mediaPositionMs, reaction, createdAt, deleted);
	}

	/** Deleted for everyone: the text is gone, a placeholder keeps its place in the chat. */
	void delete() {
		this.deleted = true;
		this.text = "";
		this.mediaPositionMs = null;
	}

	boolean isDeleted() {
		return deleted;
	}
}
