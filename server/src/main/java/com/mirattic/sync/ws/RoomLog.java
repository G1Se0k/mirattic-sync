package com.mirattic.sync.ws;

import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.RoomService;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The room's log lines in its chat (plan.md decision 78).
 * Joins and leaves: a user joins with their first connection in the room; they leave once none of their
 * connections has been in it for the grace period, so a reconnect or the extension's worker restarting writes nothing.
 * The host's play / pause / seek write no line (decision 103); a video change writes its "content" line.
 * Leaving the room (or joining another) writes the "leave" at once: no wait for a reconnect that can't come.
 * ponytail: in memory, single instance. After a restart, one reconnecting whose latest line is their "join" is followed
 * without a second one (RoomService.loggedIn); one who hasn't reconnected a minute after it gets their "leave" then.
 * Lines are written under one lock (a few per minute), so a leave can't land after a newer join.
 */
@Component
public class RoomLog {

	private final RoomService rooms;
	private final SocketHub hub;
	private final long graceMs;
	/** "room|user" logged as in the room → since when none of their connections is in it (0 = present). */
	private final Map<String, Long> inRoom = new ConcurrentHashMap<>();
	/** Room → the lock its playback commands and content changes are applied and sent under (SocketHandler). */
	private final Map<String, Object> order = new ConcurrentHashMap<>();
	/** Room → the newest content change logged: one applied earlier but arriving here later is dropped. */
	private final Map<String, Long> versions = new ConcurrentHashMap<>();

	private final long restartMs;
	private final long startedAt = System.currentTimeMillis();
	private volatile boolean restartChecked;

	RoomLog(RoomService rooms, SocketHub hub, @Value("${app.room-log-grace-ms:10000}") long graceMs,
			@Value("${app.room-log-restart-ms:60000}") long restartMs) {
		this.rooms = rooms;
		this.hub = hub;
		this.graceMs = graceMs;
		this.restartMs = restartMs;
	}

	/**
	 * Held while a room's playback command or content change is applied and sent, so they follow the versions' order.
	 * Taken before the room row and this log's lock, never while holding them.
	 * ponytail: one object per room ever played in, until restart.
	 */
	Object order(String roomId) {
		return order.computeIfAbsent(roomId, k -> new Object());
	}

	/** A connection of `userId` joined the room. */
	synchronized void joined(String roomId, String userId) {
		String key = roomId + "|" + userId;
		if (inRoom.containsKey(key)) {
			inRoom.put(key, 0L);
			return;
		}
		if (!hub.presentIn(roomId).contains(userId)) {
			return;
		}
		// Logged before the server restarted (its line still the latest): followed from here, nothing written.
		if (rooms.loggedIn(roomId, userId)) {
			inRoom.put(key, 0L);
			return;
		}
		// Written only while still a member, checked under the room lock a kick also holds: no join after a kick.
		ChatMessage.View line = rooms.logPresence(roomId, userId, "join");
		if (line != null) {
			inRoom.put(key, 0L);
			post(roomId, line);
		}
	}

	/**
	 * Left the room (no longer a member, not by a kick): their "leave" now, if they were logged as in it — known here,
	 * or, not yet followed since a restart, `loggedIn` (this membership's latest line a "join", asked as it ended).
	 */
	public synchronized void left(String roomId, String userId, boolean loggedIn) {
		if (rooms.isMemberOf(userId, roomId)) {
			return; // back in already (a new membership, logged by its own join): this leave is past
		}
		// Not tracked: written from `loggedIn` only while their latest line is still that "join" — a sweep (under this
		// lock) may have written the leave meanwhile.
		if (inRoom.remove(roomId + "|" + userId) != null || loggedIn && rooms.lastLineIsJoin(roomId, userId)) {
			post(roomId, rooms.logPresence(roomId, userId, "leave"));
		}
	}

	/**
	 * Once, a while after a restart: members logged as in their room before it (latest line their "join") who haven't
	 * come back get their "leave".
	 */
	public synchronized void sweepUnseen() {
		for (String[] m : rooms.memberships()) {
			String roomId = m[0];
			String userId = m[1];
			if (!inRoom.containsKey(roomId + "|" + userId) && !hub.presentIn(roomId).contains(userId)
					&& rooms.loggedIn(roomId, userId)) {
				post(roomId, rooms.logPresence(roomId, userId, "leave"));
			}
		}
		restartChecked = true; // only once all went through: a failure is tried again next sweep (written ones are skipped)
	}

	/** Kicked: their "kick" line says it, no "leave" line after it. */
	public synchronized void forget(String roomId, String userId) {
		inRoom.remove(roomId + "|" + userId);
	}

	@Scheduled(fixedDelayString = "${app.room-log-sweep-ms:5000}")
	public void sweep() {
		long now = System.currentTimeMillis();
		if (!restartChecked && now - startedAt >= restartMs) {
			sweepUnseen();
		}
		for (Map.Entry<String, Long> e : inRoom.entrySet()) {
			String key = e.getKey();
			String roomId = key.substring(0, key.indexOf('|'));
			String userId = key.substring(key.indexOf('|') + 1);
			long since = e.getValue();
			if (hub.presentIn(roomId).contains(userId)) {
				inRoom.replace(key, since, 0L);
			} else if (since == 0L) {
				inRoom.replace(key, 0L, now);
			} else if (now - since >= graceMs) {
				leave(key, roomId, userId, since);
			}
		}
	}

	private synchronized void leave(String key, String roomId, String userId, long since) {
		// Asked again under the lock: not if they came back meanwhile.
		if (!hub.presentIn(roomId).contains(userId) && inRoom.remove(key, since)) {
			post(roomId, rooms.logPresence(roomId, userId, "leave"));
		}
	}

	/** A new video: its "content" line, unless a newer change was logged already. */
	synchronized void contentChanged(String roomId, long version, ChatMessage.View log) {
		if (newer(roomId, version)) {
			post(roomId, log);
		}
	}

	private boolean newer(String roomId, long version) {
		Long seen = versions.get(roomId);
		if (seen != null && seen >= version) {
			return false;
		}
		// ponytail: one entry per room ever played in, until restart; prune with closed rooms if it grows.
		versions.put(roomId, version);
		return true;
	}

	/** To the connections in the room; the others see it in the history. */
	public void post(String roomId, ChatMessage.View log) {
		if (log != null) {
			hub.sendToRoom(roomId, new ServerEvent("chat:log", roomId, log.userId(), null, log.createdAt(), log));
		}
	}
}
