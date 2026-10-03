package com.mirattic.sync.room;

import com.mirattic.sync.presence.MediaProvider;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

/** Mirrors `RoomContent` in packages/types. Metadata only. */
public record RoomContent(
		@NotNull MediaProvider provider,
		@NotBlank @Size(max = 512) String contentId,
		@NotBlank @Size(max = 300) String title,
		@PositiveOrZero Long durationMs,
		@Size(max = 2048) @Pattern(regexp = "https://\\S+") String canonicalUrl,
		/** Same value = same series: members follow the host's next video without asking. */
		@Size(max = 128) @Pattern(regexp = "[A-Za-z0-9_-]+") String series,
		/** Who made it (YouTube's channel), where the page says: only for the "content" line, not kept with the room. */
		@Size(max = 100) String channel) {

	/** The "content" line's text: "<channel> - <title>", or the title alone. */
	String label() {
		return channel == null || channel.isBlank() ? title : channel.strip() + " - " + title;
	}
}
