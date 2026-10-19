package com.mirattic.sync.presence;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.Visibility;
import com.mirattic.sync.ws.SocketHub;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.transaction.event.TransactionalEventListener;
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
	private final RoomService rooms;

	PresenceService(SocketHub hub, FriendshipRepository friendships, UserRepository users, RoomService rooms) {
		this.hub = hub;
		this.friendships = friendships;
		this.users = users;
		this.rooms = rooms;
	}

	/** Their friends see them in another public room, or none (decision 114). After the commit, or at once outside one. */
	@TransactionalEventListener(fallbackExecution = true)
	void roomsChanged(RoomsChanged event) {
		event.userIds().forEach(this::broadcast);
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

	/** What the user watches now (their own presence, whatever their visibility), or null. Server-side use only. */
	public MediaPresence watching(String userId) {
		return media.get(userId);
	}

	/** Presence of `owner` as seen by one of their friends. Callers must have checked friendship. */
	public PresenceView viewOf(User owner, String viewer) {
		PresenceView v = view(owner, hub.isOnline(owner.getId()), media.get(owner.getId()));
		// Online, watching or not; never for one hiding their activity (publicRoomOf checks visibility 친구).
		if (v.status() == PresenceView.Status.OFFLINE) {
			return v;
		}
		MediaPresence m = v.media();
		return new PresenceView(v.status(), m, rooms.publicRoomOf(owner.getId(), m != null ? m.provider() : null, m != null ? m.contentId() : null, viewer));
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
		// Blocking deletes the friendship, so blocked users are never in this list. Each friend's own view: the public
		// room shown depends on who looks (decision 114). ponytail: a few reads per friend per change; one shared
		// lookup of the owner's room with per-viewer filtering if friend lists grow large.
		for (String friendId : friendships.friendIds(userId)) {
			hub.sendEvent(friendId, "presence:update", userId, viewOf(owner, friendId));
		}
	}
}
