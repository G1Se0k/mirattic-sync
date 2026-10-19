package com.mirattic.sync.presence;

/**
 * What a friend is allowed to see. `media` is null when not watching or not shared. `publicRoom`: the public room
 * they are in while online with visibility 친구, watching or not (decision 114), else null.
 */
public record PresenceView(Status status, MediaPresence media, PublicRoom publicRoom) {

	public PresenceView(Status status, MediaPresence media) {
		this(status, media, null);
	}

	public enum Status {
		OFFLINE, ONLINE, WATCHING
	}

	/** `name`: the room's name, else its video's title, else null. */
	public record PublicRoom(String name) {}
}
