package com.mirattic.sync.ws;

import com.mirattic.sync.room.RoomService;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Rooms their host isn't in close by themselves (plan.md decisions 75, 90): a room without a live connection of its
 * host at two sweeps in a row (one to two minutes) is closed, and its members told (`room:closed`), as if the host
 * had left — an empty room included. A short gap — a reconnect, the extension's worker restarting — doesn't close
 * it. The backstop of the 30 s wait after the host's leave (SocketHandler), which a server restart forgets.
 * ponytail: scans every room each minute and remembers in memory (single instance); an index on activity if rooms
 * grow into the thousands.
 */
@Component
public class EmptyRooms {

	private final RoomService rooms;
	private final SocketHub hub;
	/** Without their host at the previous sweep. */
	private Set<String> seenAway = Set.of();

	EmptyRooms(RoomService rooms, SocketHub hub) {
		this.rooms = rooms;
		this.hub = hub;
	}

	@Scheduled(fixedDelayString = "${app.empty-room-sweep-ms:60000}", initialDelayString = "${app.empty-room-sweep-ms:60000}")
	public synchronized void sweep() {
		Map<String, String> hosts = rooms.hosts();
		Set<String> away = new HashSet<>();
		for (String roomId : rooms.allIds()) {
			String host = hosts.get(roomId);
			if (host == null || hub.presentIn(roomId).contains(host)) {
				continue;
			}
			if (!seenAway.contains(roomId)) {
				away.add(roomId);
				continue;
			}
			// Checked again and closed under the room's entry lock: the host joining right now keeps it.
			RoomService.Left left = hub.whileAbsent(roomId, host, () -> rooms.closeHostedBy(host, roomId));
			if (left != null) {
				rooms.announceClosed(roomId, host, left);
			}
		}
		seenAway = away;
	}
}
