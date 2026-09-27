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
		@Size(max = 2048) @Pattern(regexp = "https://\\S+") String canonicalUrl) {
}
