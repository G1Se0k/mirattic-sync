package com.mirattic.sync.presence;

/** What a friend is allowed to see. `media` is null when not watching or not shared. */
public record PresenceView(Status status, MediaPresence media) {

	public enum Status {
		OFFLINE, ONLINE, WATCHING
	}
}
