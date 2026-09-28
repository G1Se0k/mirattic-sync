package com.mirattic.sync.room;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "chat_messages")
public class ChatMessage {

	/** Mirrors `ChatMessage` in packages/types. A reaction's text is its emoji. */
	public record View(String id, String roomId, String userId, String text, Long mediaPositionMs, boolean reaction,
			long createdAt) {
	}

	@Id
	private String id;
	private String roomId;
	private String userId;
	private String text;
	private Long mediaPositionMs;
	private boolean reaction;
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
		return new View(id, roomId, userId, text, mediaPositionMs, reaction, createdAt);
	}
}
