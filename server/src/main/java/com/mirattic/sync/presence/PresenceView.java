package com.mirattic.sync.presence;

/**
 * What a friend is allowed to see. `media` is null when not watching or not shared. `publicRoom`: the public room
 * they are in while online with visibility 친구, watching or not (decision 114), else null. `doNotDisturb`: true while
 * online with 방해 금지 on (decision 121), else null.
 */
public record PresenceView(Status status, MediaPresence media, PublicRoom publicRoom, Boolean doNotDisturb) {

	public PresenceView(Status status, MediaPresence media) {
		this(status, media, null, null);
	}

	public PresenceView(Status status, MediaPresence media, PublicRoom publicRoom) {
		this(status, media, publicRoom, null);
	}

	public enum Status {
		OFFLINE, ONLINE, WATCHING
	}

	/** `name`: the room's name, else its video's title, else null. */
	public record PublicRoom(String name) {}
}
