package com.mirattic.sync.ws;

import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.RoomService;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * "X님이 들어왔습니다 / 나갔습니다" in the room's chat (plan.md decision 78). A user joins with their first
 * connection in the room; they leave once none of their connections has been in it for the grace period, so a
 * reconnect or the extension's worker restarting writes nothing.
 * ponytail: in memory, single instance; after a server restart everyone reconnecting is logged as joining again.
 * Joins and leaves are written under one lock (few per minute), so a leave can't land after a newer join.
 */
@Component
public class RoomLog {

	private final RoomService rooms;
	private final SocketHub hub;
	private final long graceMs;
	/** "room|user" logged as in the room → since when none of their connections is in it (0 = present). */
	private final Map<String, Long> inRoom = new ConcurrentHashMap<>();

	RoomLog(RoomService rooms, SocketHub hub, @Value("${app.room-log-grace-ms:10000}") long graceMs) {
		this.rooms = rooms;
		this.hub = hub;
		this.graceMs = graceMs;
	}

	/** A connection of `userId` joined the room. */
	synchronized void joined(String roomId, String userId) {
		if (inRoom.put(roomId + "|" + userId, 0L) == null) {
			post(roomId, rooms.logPresence(roomId, userId, "join"));
		}
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

	/** To the connections in the room; the others see it in the history. */
	void post(String roomId, ChatMessage.View log) {
		if (log != null) {
			hub.sendToRoom(roomId, new ServerEvent("chat:log", roomId, log.userId(), null, log.createdAt(), log));
		}
	}
}
