package com.mirattic.sync.room;

import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.user.FriendCode;
import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;
import java.util.HashSet;
import java.util.Set;
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
	private String series;
	private long positionMs;
	private boolean playing;
	private long capturedAt;
	private String playbackBy;
	private long playbackVersion;
	private long createdAt;
	/** Joining by code (decision 77). */
	private String code;
	/** Kicked by the host (decision 79): not back by the code; the host's invite lifts it. */
	@ElementCollection
	@CollectionTable(name = "room_bans", joinColumns = @JoinColumn(name = "room_id"))
	@Column(name = "user_id")
	private Set<String> banned = new HashSet<>();

	protected Room() {
	}

	Room(RoomContent content, String hostId) {
		this.id = UUID.randomUUID().toString();
		this.provider = content.provider();
		this.contentId = content.contentId();
		this.title = content.title();
		this.durationMs = content.durationMs();
		this.canonicalUrl = content.canonicalUrl();
		this.series = content.series();
		this.createdAt = this.capturedAt = System.currentTimeMillis();
		this.playbackBy = hostId;
		this.code = FriendCode.generate();
	}

	public String getId() { return id; }
	public long getCreatedAt() { return createdAt; }
	public String getCode() { return code; }

	void newCode() { this.code = FriendCode.generate(); }

	boolean isBanned(String userId) { return banned.contains(userId); }
	void ban(String userId) { banned.add(userId); }
	void unban(String userId) { banned.remove(userId); }

	RoomContent content() {
		return new RoomContent(provider, contentId, title, durationMs, canonicalUrl, series);
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

	/** @return false if it is the same video (new metadata such as a playlist only): the playback stays as it is. */
	boolean changeContent(String userId, RoomContent content, long now) {
		boolean restart = provider != content.provider() || !contentId.equals(content.contentId());
		this.provider = content.provider();
		this.contentId = content.contentId();
		this.title = content.title();
		this.durationMs = content.durationMs();
		this.canonicalUrl = content.canonicalUrl();
		this.series = content.series();
		if (restart) {
			applyPlayback(userId, 0, false, now);
		}
		return restart;
	}

	/** Where playback is at `now`, extrapolated like the clients do. */
	long positionAt(long now) {
		long position = positionMs + (playing ? Math.max(0, now - capturedAt) : 0);
		return durationMs == null ? position : Math.min(position, durationMs);
	}

	boolean isPlaying() {
		return playing;
	}
}
