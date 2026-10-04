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
 * ponytail: in memory, single instance; after a server restart everyone reconnecting is logged as joining again.
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

	RoomLog(RoomService rooms, SocketHub hub, @Value("${app.room-log-grace-ms:10000}") long graceMs) {
		this.rooms = rooms;
		this.hub = hub;
		this.graceMs = graceMs;
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
		// Written only while still a member, checked under the room lock a kick also holds: no join after a kick.
		ChatMessage.View line = rooms.logPresence(roomId, userId, "join");
		if (line != null) {
			inRoom.put(key, 0L);
			post(roomId, line);
		}
	}

	/** Kicked: their "kick" line says it, no "leave" line after it. */
	public synchronized void forget(String roomId, String userId) {
		inRoom.remove(roomId + "|" + userId);
	}

	@Scheduled(fixedDelayString = "${app.room-log-sweep-ms:5000}")
	public void sweep() {
		long now = System.currentTimeMillis();
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
