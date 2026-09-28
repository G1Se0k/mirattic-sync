package com.mirattic.sync.room;

import com.mirattic.sync.presence.MediaProvider;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "rooms")
public class Room {

	@Id
	private String id;
	@Enumerated(EnumType.STRING)
	private MediaProvider provider;
	private String contentId;
	private String title;
	private Long durationMs;
	private String canonicalUrl;
	private long positionMs;
	private boolean playing;
	private long capturedAt;
	private String playbackBy;
	private long playbackVersion;
	private long createdAt;

	protected Room() {
	}

	Room(RoomContent content, String hostId) {
		this.id = UUID.randomUUID().toString();
		this.provider = content.provider();
		this.contentId = content.contentId();
		this.title = content.title();
		this.durationMs = content.durationMs();
		this.canonicalUrl = content.canonicalUrl();
		this.createdAt = this.capturedAt = System.currentTimeMillis();
		this.playbackBy = hostId;
	}

	public String getId() { return id; }
	public long getCreatedAt() { return createdAt; }

	RoomContent content() {
		return new RoomContent(provider, contentId, title, durationMs, canonicalUrl);
	}

	PlaybackState playback() {
		return new PlaybackState(provider, contentId, positionMs, durationMs, playing, capturedAt, playbackBy,
				playbackVersion);
	}

	/** Every accepted command bumps the version, even if nothing changed, so the order is total. */
	void applyPlayback(String userId, long positionMs, boolean playing, long capturedAt) {
		this.positionMs = durationMs == null ? positionMs : Math.min(positionMs, durationMs);
		this.playing = playing;
		this.capturedAt = capturedAt;
		this.playbackBy = userId;
		this.playbackVersion++;
	}

	void changeContent(String userId, RoomContent content, long now) {
		this.provider = content.provider();
		this.contentId = content.contentId();
		this.title = content.title();
		this.durationMs = content.durationMs();
		this.canonicalUrl = content.canonicalUrl();
		applyPlayback(userId, 0, false, now);
	}

	boolean isPlaying() {
		return playing;
	}
}
