package com.mirattic.sync.presence;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

/** Mirrors `MediaPresence` in packages/types. Metadata only — never media or provider credentials. */
public record MediaPresence(
		@NotNull MediaProvider provider,
		@Size(max = 512) String contentId,
		@NotBlank @Size(max = 300) String title,
		/** The YouTube channel, as the watch page shows it. */
		@Size(max = 200) String channel,
		@Size(max = 300) String episodeTitle,
		@PositiveOrZero Integer season,
		@PositiveOrZero Integer episode,
		@Size(max = 2048) @Pattern(regexp = "https://\\S+") String thumbnailUrl,
		@Size(max = 2048) @Pattern(regexp = "https://\\S+") String canonicalUrl,
		@PositiveOrZero Long positionMs,
		@PositiveOrZero Long durationMs,
		boolean playing,
		long capturedAt) {

	MediaPresence withoutPosition() {
		return new MediaPresence(provider, contentId, title, channel, episodeTitle, season, episode, thumbnailUrl,
				canonicalUrl, null, durationMs, playing, capturedAt);
	}
}
