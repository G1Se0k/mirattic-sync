package com.mirattic.sync.room;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "chat_messages")
public class ChatMessage {

	/**
	 * Mirrors `ChatMessage` in packages/types. `kind` null = a message someone wrote; else a room log (decision 78):
	 * "join" / "leave" (text = the name then), "content" (text = the title), "kick" / "host" (text = that member's name),
	 * "stamp" (a member's timestamp, text = their name then). `contentKey`: the video a position belongs to.
	 */
	/**
	 * `userName`: a message's author's name now (decision 112), so one who left still shows by name; else null.
	 * `mentions`: the members it names with "@name" (decision 118), null for none. `mentionSpans`: where the text
	 * shows a mention kept by ID, as "@<their name now>" (decision 122) — `start` / `end` in UTF-16 units; null for none.
	 */
	public record View(String id, String roomId, String userId, String text, Long mediaPositionMs, String kind,
			long createdAt, boolean deleted, String contentKey, String userName, List<String> mentions,
			List<Span> mentionSpans) {
		/** A line naming its member (join / leave / kick / host / stamp) with the name they have now (null: as written). */
		View namedNow(String name) {
			return name == null || !NAMING.contains(kind) ? this
					: new View(id, roomId, userId, name, mediaPositionMs, kind, createdAt, deleted, contentKey, userName, mentions, mentionSpans);
		}

		View named(String name) {
			return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, deleted, contentKey, name, mentions, mentionSpans);
		}

		/** As shown (decision 122): each "\uE000<id>\uE000" in the text as "@<their name now>", and those names. */
		View shown(java.util.function.Function<String, String> nameOf) {
			if (mentions == null) {
				return this;
			}
			StringBuilder out = new StringBuilder();
			List<Span> spans = new java.util.ArrayList<>();
			// The mentioned one's place in `mentions` between two marks.
			java.util.regex.Matcher m = java.util.regex.Pattern.compile(MARK + "([0-9]{1,3})" + MARK).matcher(text);
			int from = 0;
			while (m.find()) {
				out.append(text, from, m.start());
				int at = Integer.parseInt(m.group(1));
				String who = at < mentions.size() ? mentions.get(at) : null;
				String name = who == null || who.equals(RoomService.EVERYONE) ? null : nameOf.apply(who);
				int start = out.length();
				out.append('@').append(name != null ? name : UNKNOWN);
				if (name != null) {
					spans.add(new Span(who, start, out.length()));
				}
				from = m.end();
			}
			out.append(text, from, text.length());
			return new View(id, roomId, userId, out.toString(), mediaPositionMs, kind, createdAt, deleted, contentKey, userName,
					mentions, spans.isEmpty() ? null : spans);
		}
	}

	/** The log lines whose text is their member's name (decision 123: shown with the name now). */
	static final java.util.Set<String> NAMING = java.util.Set.of("join", "leave", "kick", "host", "stamp");

	/** A mention shown in a text: `id`'s, from `start` to `end` (the "@" included). */
	public record Span(String id, int start, int end) {
	}

	/**
	 * Around a mentioned one's place in `mentions` in a stored text (decision 122): a private-use character no one can
	 * send. "@name" (2 characters or more) becomes at most 5 — `mentions` has far fewer than 1000 — so a text sent
	 * within 1000 characters is stored within 2500.
	 */
	static final String MARK = "\uE000";
	private static final String UNKNOWN = "알 수 없음";

	@Id
	private String id;
	private String roomId;
	private String userId;
	@Column(length = 4000)
	private String text;
	private Long mediaPositionMs;
	private String kind;
	/** "<provider>:<contentId>" of the room's video when written, with a position only. */
	private String contentKey;
	private boolean deleted;
	/** Mentioned members' IDs, comma-separated (decision 118); null for none. */
	private String mentions;
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
		return new View(id, roomId, userId, text, mediaPositionMs, kind, createdAt, deleted, contentKey, null,
				mentions == null ? null : Arrays.asList(mentions.split(",")), null);
	}

	/** Names these members (none: nothing). */
	ChatMessage mentioning(List<String> ids) {
		this.mentions = ids.isEmpty() ? null : String.join(",", ids);
		return this;
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
		this.mentions = null;
	}

	boolean isLog() {
		return kind != null;
	}

	boolean isDeleted() {
		return deleted;
	}

	String kind() { return kind; }
	long createdAt() { return createdAt; }
}
