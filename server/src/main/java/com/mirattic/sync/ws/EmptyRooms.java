package com.mirattic.sync.ws;

import com.mirattic.sync.room.RoomService;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Rooms nobody is in close by themselves (plan.md decision 75): a room without any live connection at two sweeps
 * in a row (one to two minutes) is closed for its members, as if the host had left. A short gap — a reconnect,
 * the extension's worker restarting — doesn't close it.
 * ponytail: scans every room each minute and remembers in memory (single instance); an index on activity if rooms
 * grow into the thousands.
 */
@Component
public class EmptyRooms {

	private final RoomService rooms;
	private final SocketHub hub;
	/** Empty at the previous sweep. */
	private Set<String> seenEmpty = Set.of();

	EmptyRooms(RoomService rooms, SocketHub hub) {
		this.rooms = rooms;
		this.hub = hub;
	}

	@Scheduled(fixedDelayString = "${app.empty-room-sweep-ms:60000}", initialDelayString = "${app.empty-room-sweep-ms:60000}")
	public synchronized void sweep() {
		Set<String> empty = new HashSet<>();
		for (String roomId : rooms.allIds()) {
			if (!hub.presentIn(roomId).isEmpty()) {
				continue;
			}
			if (!seenEmpty.contains(roomId)) {
				empty.add(roomId);
				continue;
			}
			// Checked again and closed under the room's join lock: someone joining right now keeps it.
			List<String> memberIds = hub.closeIfEmpty(roomId, () -> rooms.close(roomId), null);
			if (memberIds != null) {
				rooms.announce(roomId, memberIds);
			}
		}
		seenEmpty = empty;
	}
}
