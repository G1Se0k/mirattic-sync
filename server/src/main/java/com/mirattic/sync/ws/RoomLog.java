package com.mirattic.sync.ws;

import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.RoomService;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The room's log lines in its chat (plan.md decision 78).
 * Joins and leaves: a user joins with their first connection in the room; they leave once none of their
 * connections has been in it for the grace period, so a reconnect or the extension's worker restarting writes nothing.
 * The host's playback: play / pause when the state flips, a seek when the position jumps. Dragging the seek bar
 * pauses, moves and plays again, so that pause is held: a play after it makes one "seek" line (if it moved)
 * instead of "pause" + "play". Where the host's page says whether the seek bar is held (`scrubbing`, decision 86:
 * YouTube), a pause without it is written at once and one with it is held until the drag ends; elsewhere every
 * pause is held a moment.
 * ponytail: in memory, single instance; after a server restart everyone reconnecting is logged as joining again.
 * Lines are written under one lock (a few per minute), so a leave can't land after a newer join.
 */
@Component
public class RoomLog {

	/** A "seek" landing this close to where playback would be anyway (e.g. a title update) is no move: no line. */
	static final long MIN_JUMP_MS = 2_000;

	private final RoomService rooms;
	private final SocketHub hub;
	private final long graceMs;
	private final long pauseHoldMs;
	/** "room|user" logged as in the room → since when none of their connections is in it (0 = present). */
	private final Map<String, Long> inRoom = new ConcurrentHashMap<>();
	/** Room → the lock its playback commands are applied and logged under (SocketHandler). */
	private final Map<String, Object> order = new ConcurrentHashMap<>();
	/** Room → the newest playback version logged: a command applied earlier but arriving here later is dropped. */
	private final Map<String, Long> versions = new ConcurrentHashMap<>();
	/** A pause held while the host holds the seek bar is written anyway after this long (a drag left hanging). */
	public static final long SCRUB_HOLD_MS = 30_000;
	/** Room → a pause not written yet (guarded by this). */
	private final Map<String, Held> held = new ConcurrentHashMap<>();

	private static final class Held {
		final String userId;
		final long pausedPosition;
		/** Where playback was before the pause: every later position is judged against it, so small steps add up. */
		final long baseline;
		long position;
		long lastAt;
		boolean moved;
		/** Held because the host's page says the seek bar is held: waits for the drag to end, not the hold time. */
		final boolean scrubbing;
		/** When the hold started: a drag's hold ends SCRUB_HOLD_MS after it, however long the moves go on. */
		final long since;

		Held(String userId, long pausedPosition, long baseline, long position, long lastAt, boolean moved,
				boolean scrubbing) {
			this.userId = userId;
			this.pausedPosition = pausedPosition;
			this.baseline = baseline;
			this.position = position;
			this.lastAt = lastAt;
			this.moved = moved;
			this.scrubbing = scrubbing;
			this.since = lastAt;
		}

		/** Past its time: a drag SCRUB_HOLD_MS after it began, otherwise the hold time after the last command. */
		boolean due(long now, long pauseHoldMs) {
			return scrubbing ? now - since >= SCRUB_HOLD_MS : now - lastAt >= pauseHoldMs;
		}
	}

	RoomLog(RoomService rooms, SocketHub hub, @Value("${app.room-log-grace-ms:10000}") long graceMs,
			@Value("${app.room-log-pause-hold-ms:1000}") long pauseHoldMs) {
		this.rooms = rooms;
		this.hub = hub;
		this.graceMs = graceMs;
		this.pauseHoldMs = pauseHoldMs;
	}

	/**
	 * Held while a room's playback command is applied and then logged, so lines follow the versions' order.
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

	/**
	 * After a host's playback command was applied. `scrubbing`: whether the host holds the seek bar, null where
	 * their page can't tell.
	 */
	synchronized void playback(String roomId, String me, RoomService.Applied a, Boolean scrubbing) {
		if (!newer(roomId, a.state().version())) {
			return;
		}
		long now = System.currentTimeMillis();
		boolean jumped = Math.abs(a.landed() - a.expected()) >= MIN_JUMP_MS;
		Held h = held.get(roomId);
		// Held past its time (the sweep hasn't run yet), or another host now: written as it was.
		if (h != null && (h.due(now, pauseHoldMs) || !h.userId.equals(me))) {
			writeHeld(roomId, held.remove(roomId));
			h = null;
		}
		if (h != null) {
			h.moved |= jumped || Math.abs(a.landed() - h.baseline) >= MIN_JUMP_MS;
			h.position = a.landed();
			h.lastAt = now; // still dragging: keep holding
			if (a.state().playing()) { // played again soon: one "seek" line if it moved, else nothing
				held.remove(roomId);
				if (h.moved) {
					post(roomId, rooms.log(roomId, me, "seek", "", a.landed()));
				}
			} else if (Boolean.FALSE.equals(scrubbing)) { // the bar let go and still paused: a real pause (+ move)
				writeHeld(roomId, held.remove(roomId));
			}
			return;
		}
		if (a.wasPlaying() && !a.state().playing()) {
			// Paused somewhere else (the drag's first report): the pause is where it was, the move comes after.
			Held pause = new Held(me, jumped ? a.expected() : a.landed(), a.expected(), a.landed(), now, jumped,
					Boolean.TRUE.equals(scrubbing));
			if (Boolean.FALSE.equals(scrubbing)) {
				writeHeld(roomId, pause); // not the seek bar: a pause, now
			} else {
				held.put(roomId, pause);
			}
		} else if (!a.wasPlaying() && a.state().playing()) {
			post(roomId, rooms.log(roomId, me, "play", "", a.landed()));
		} else if (jumped) {
			post(roomId, rooms.log(roomId, me, "seek", "", a.landed()));
		}
	}

	/** A new video: a pause still held is about the old one, and the "content" line says what happened. */
	synchronized void contentChanged(String roomId, long version, ChatMessage.View log) {
		if (!newer(roomId, version)) {
			return;
		}
		held.remove(roomId);
		post(roomId, log);
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

	@Scheduled(fixedDelayString = "${app.room-log-hold-sweep-ms:200}")
	public void flushHeld() {
		flushHeld(System.currentTimeMillis());
	}

	/** Writes the pauses held past the hold time (a test passes a far `now`). */
	public synchronized void flushHeld(long now) {
		for (Iterator<Map.Entry<String, Held>> it = held.entrySet().iterator(); it.hasNext();) {
			Map.Entry<String, Held> e = it.next();
			if (e.getValue().due(now, pauseHoldMs)) {
				it.remove();
				writeHeld(e.getKey(), e.getValue());
			}
		}
	}

	private void writeHeld(String roomId, Held h) {
		post(roomId, rooms.log(roomId, h.userId, "pause", "", h.pausedPosition));
		if (h.moved) {
			post(roomId, rooms.log(roomId, h.userId, "seek", "", h.position));
		}
	}

	/** To the connections in the room; the others see it in the history. */
	public void post(String roomId, ChatMessage.View log) {
		if (log != null) {
			hub.sendToRoom(roomId, new ServerEvent("chat:log", roomId, log.userId(), null, log.createdAt(), log));
		}
	}
}
