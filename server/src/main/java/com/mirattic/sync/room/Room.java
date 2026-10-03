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
import jakarta.persistence.MapKeyColumn;
import jakarta.persistence.Table;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
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
	/** The site the host picked, or its video's (decision 93); null: none yet. */
	@Enumerated(EnumType.STRING)
	private MediaProvider roomType;
	/** Rises with every type change (members' notices and answers are about one version). */
	private long roomTypeVersion;
	private long positionMs;
	private boolean playing;
	/** The host's playback speed (1 = normal). */
	private double playbackRate = 1;
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
	/**
	 * Invited by the host, not answered yet (decision 85): accepting makes them a member. Value: when (epoch ms);
	 * an invitation counts for `RoomService.INVITATION_MS` (decision 87).
	 */
	@ElementCollection
	@CollectionTable(name = "room_invitations", joinColumns = @JoinColumn(name = "room_id"))
	@MapKeyColumn(name = "user_id")
	@Column(name = "invited_at")
	private Map<String, Long> invited = new HashMap<>();

	protected Room() {
	}

	/** `content` null: no video yet (decision 92); the host's first one becomes it. */
	Room(RoomContent content, String hostId) {
		this.id = UUID.randomUUID().toString();
		if (content != null) {
			this.provider = content.provider();
			this.contentId = content.contentId();
			this.title = content.title();
			this.durationMs = content.durationMs();
			this.canonicalUrl = content.canonicalUrl();
			this.series = content.series();
			this.roomType = content.provider();
		}
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

	/** Invites anew: an earlier invitation's time starts over. */
	void invite(String userId, long at) { invited.put(userId, at); }
	Set<String> invitedIds() { return Set.copyOf(invited.keySet()); }
	/** When they were invited, or null. */
	Long invitedAt(String userId) { return invited.get(userId); }
	/** @return whether they were invited (and now aren't). */
	boolean uninvite(String userId) { return invited.remove(userId) != null; }

	/** "<provider>:<contentId>", what a chat line's position belongs to; null without a video. */
	String contentKey() {
		return provider == null ? null : provider + ":" + contentId;
	}

	/** null: no video yet. */
	RoomContent content() {
		if (provider == null) {
			return null;
		}
		return new RoomContent(provider, contentId, title, durationMs, canonicalUrl, series, null);
	}

	PlaybackState playback() {
		return new PlaybackState(provider, contentId, positionMs, durationMs, playing, playbackRate, capturedAt,
				playbackBy, playbackVersion);
	}

	/** Every accepted command bumps the version, even if nothing changed, so the order is total. */
	void applyPlayback(String userId, long positionMs, boolean playing, double rate, long capturedAt) {
		this.positionMs = durationMs == null ? positionMs : Math.min(positionMs, durationMs);
		this.playing = playing;
		this.playbackRate = rate;
		this.capturedAt = capturedAt;
		this.playbackBy = userId;
		this.playbackVersion++;
	}

	MediaProvider type() {
		return roomType;
	}

	long typeVersion() {
		return roomTypeVersion;
	}

	/** @return whether it changed. */
	boolean setType(MediaProvider type) {
		if (type == roomType) {
			return false;
		}
		roomType = type;
		roomTypeVersion++;
		return true;
	}

	/** @return false if it is the same video (new metadata such as a playlist only): the playback stays as it is. */
	boolean changeContent(String userId, RoomContent content, long now) {
		boolean restart = provider != content.provider() || !content.contentId().equals(contentId);
		this.provider = content.provider();
		this.contentId = content.contentId();
		this.title = content.title();
		this.durationMs = content.durationMs();
		this.canonicalUrl = content.canonicalUrl();
		this.series = content.series();
		if (restart) {
			applyPlayback(userId, 0, false, playbackRate, now);
		}
		return restart;
	}

	/** Where playback is at `now`, extrapolated like the clients do. */
	long positionAt(long now) {
		long position = positionMs + (playing ? Math.round(Math.max(0, now - capturedAt) * playbackRate) : 0);
		return durationMs == null ? position : Math.min(position, durationMs);
	}

	double rate() {
		return playbackRate;
	}

	boolean isPlaying() {
		return playing;
	}
}
