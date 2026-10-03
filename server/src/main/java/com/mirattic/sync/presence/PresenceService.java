package com.mirattic.sync.presence;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.Visibility;
import com.mirattic.sync.ws.SocketHub;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/**
 * In-memory presence. Viewing activity is ephemeral, so it is never persisted.
 * ponytail: single-instance only; move to Redis pub/sub when the server scales out.
 */
@Service
public class PresenceService {

	private final Map<String, MediaPresence> media = new ConcurrentHashMap<>();
	private final SocketHub hub;
	private final FriendshipRepository friendships;
	private final UserRepository users;

	PresenceService(SocketHub hub, FriendshipRepository friendships, UserRepository users) {
		this.hub = hub;
		this.friendships = friendships;
		this.users = users;
	}

	public void online(String userId) {
		broadcast(userId);
	}

	public void offline(String userId) {
		media.remove(userId);
		broadcast(userId);
	}

	/** `presence` null means the user stopped watching. */
	public void update(String userId, MediaPresence presence) {
		if (presence == null) {
			media.remove(userId);
		} else {
			media.put(userId, presence);
		}
		broadcast(userId);
	}

	/** Presence of `owner` as seen by one of their friends. Callers must have checked friendship. */
	public PresenceView viewOf(User owner) {
		return view(owner, hub.isOnline(owner.getId()), media.get(owner.getId()));
	}

	static PresenceView view(User owner, boolean online, MediaPresence current) {
		if (!online) {
			return new PresenceView(PresenceView.Status.OFFLINE, null);
		}
		// OFF and ROOM_ONLY both hide activity from the friend list; ROOM_ONLY is honoured inside rooms (Phase 2).
		if (current == null || owner.getPresenceVisibility() != Visibility.FRIENDS) {
			return new PresenceView(PresenceView.Status.ONLINE, null);
		}
		// The playback position never goes to friends (decision 98: its setting is gone; room members get the room's).
		return new PresenceView(PresenceView.Status.WATCHING, current.withoutPosition());
	}

	private void broadcast(String userId) {
		User owner = users.findById(userId).orElse(null);
		if (owner == null) {
			return;
		}
		PresenceView view = viewOf(owner);
		// Blocking deletes the friendship, so blocked users are never in this list.
		for (String friendId : friendships.friendIds(userId)) {
			hub.sendEvent(friendId, "presence:update", userId, view);
		}
	}
}
