package com.mirattic.sync.room;

import com.mirattic.sync.presence.MediaProvider;

/** Mirrors `PlaybackState` in packages/types. `capturedAt` is server time; `rate` the playback speed (1 = normal). */
public record PlaybackState(MediaProvider provider, String contentId, long positionMs, Long durationMs,
		boolean playing, double rate, long capturedAt, String sourceUserId, long version) {
}
