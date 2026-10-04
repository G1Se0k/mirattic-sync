package com.mirattic.sync.ws;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

/**
 * Live sessions per user (one: the latest device, decision 89), and which sessions have joined which room.
 * ponytail: in-memory, single-instance only; move to Redis pub/sub alongside presence.
 */
@Component
public class SocketHub {

	private static final Logger log = LoggerFactory.getLogger(SocketHub.class);

	private final Map<String, Set<WebSocketSession>> sessions = new ConcurrentHashMap<>();
	private final Map<String, Set<WebSocketSession>> rooms = new ConcurrentHashMap<>();
	private final JsonMapper json;

	SocketHub(JsonMapper json) {
		this.json = json;
	}

	/** A connection another device's replaced (decision 89): told so, then closed with this. */
	public static final CloseStatus REPLACED = new CloseStatus(4001, "replaced");

	/**
	 * One device at a time (decision 89): the new session becomes the user's only one, in one step, so two
	 * arriving together can't close each other. The ones it replaces get `session:replaced` and are closed.
	 * @return true if the user had no session (they just came online).
	 */
	boolean add(String userId, WebSocketSession session) {
		List<WebSocketSession> replaced = new ArrayList<>();
		synchronized (lockFor(userId)) { // after any frame of the old device still being handled
			sessions.compute(userId, (k, set) -> {
				if (set != null) {
					replaced.addAll(set);
				}
				Set<WebSocketSession> only = ConcurrentHashMap.newKeySet();
				only.add(session);
				return only;
			});
		}
		for (WebSocketSession old : replaced) {
			send(old, new ServerEvent("session:replaced", null, null, null, System.currentTimeMillis(), null));
			try {
				old.close(REPLACED);
			} catch (IOException e) {
				log.debug("close failed for session {}", old.getId());
			}
		}
		return replaced.isEmpty();
	}

	/** @return true if that was the user's last session (they went offline). */
	boolean remove(String userId, WebSocketSession session) {
		boolean[] last = {false};
		sessions.computeIfPresent(userId, (k, set) -> {
			set.remove(session);
			last[0] = set.isEmpty();
			return set.isEmpty() ? null : set;
		});
		return last[0];
	}

	/** Closes every connection of the user (account deleted). */
	public void disconnect(String userId) {
		for (WebSocketSession s : sessions.getOrDefault(userId, Set.of())) {
			try {
				s.close(CloseStatus.POLICY_VIOLATION);
			} catch (IOException e) {
				log.debug("close failed for session {}", s.getId());
			}
		}
	}

	/** Cloudflare closes WebSockets idle for 100 s; a ping frame (browsers answer it) keeps them open. */
	@Scheduled(fixedRate = 30_000)
	void ping() {
		for (Set<WebSocketSession> set : sessions.values()) {
			for (WebSocketSession s : set) {
				try {
					s.sendMessage(new PingMessage());
				} catch (IOException | IllegalStateException e) {
					log.debug("ping failed for session {}", s.getId());
				}
			}
		}
	}

	/**
	 * Per user: frames are handled one at a time and a device switch waits for the one in progress.
	 * ponytail: one small object per user ever connected on this instance; evict idle ones if that grows.
	 */
	private final Map<String, Object> locks = new ConcurrentHashMap<>();

	Object lockFor(String userId) {
		return locks.computeIfAbsent(userId, k -> new Object());
	}

	/** Still the user's session (not replaced by another device since). */
	boolean isCurrent(String userId, WebSocketSession session) {
		return sessions.getOrDefault(userId, Set.of()).contains(session);
	}

	/** How long a kept event waits for its acknowledgement. */
	static final long KEPT_MS = 3_600_000;
	/**
	 * user → events kept until their app acknowledges them (`room:closed`, decision 90). ponytail: in memory,
	 * single instance, an hour.
	 */
	private final Map<String, List<ServerEvent>> kept = new ConcurrentHashMap<>();

	/**
	 * Sends the event and keeps it until `acknowledge`: every connection of the user gets it again (`sendKept`
	 * on connect), so one made or lost right now doesn't miss it. Under the user's lock, like `add`.
	 */
	public void sendKept(String userId, ServerEvent event) {
		synchronized (lockFor(userId)) {
			long now = System.currentTimeMillis();
			// Only this user's list, under their lock: another user's is theirs to prune (when they get one next).
			kept.compute(userId, (k, list) -> {
				List<ServerEvent> next = list == null ? new CopyOnWriteArrayList<>() : list;
				next.removeIf(e -> now - e.serverTime() >= KEPT_MS);
				next.add(event);
				return next;
			});
			sendEvent(userId, event);
		}
	}

	/** Expired kept events of users who didn't connect again, every 10 minutes (each list under its user's lock). */
	@Scheduled(fixedDelay = 600_000)
	void dropExpiredKept() {
		long now = System.currentTimeMillis();
		for (String userId : kept.keySet()) {
			synchronized (lockFor(userId)) {
				kept.computeIfPresent(userId, (k, l) -> {
					l.removeIf(e -> now - e.serverTime() >= KEPT_MS);
					return l.isEmpty() ? null : l;
				});
			}
		}
	}

	/** A new connection: the kept events not acknowledged yet (expired ones dropped). */
	void sendKept(String userId) {
		synchronized (lockFor(userId)) {
			long now = System.currentTimeMillis();
			List<ServerEvent> list = kept.computeIfPresent(userId, (k, l) -> {
				l.removeIf(e -> now - e.serverTime() >= KEPT_MS);
				return l.isEmpty() ? null : l;
			});
			if (list != null) {
				list.forEach(e -> sendEvent(userId, e));
			}
		}
	}

	/** The user's app has the kept event of this type and room: not sent again. */
	void acknowledge(String userId, String type, String roomId) {
		synchronized (lockFor(userId)) {
			kept.computeIfPresent(userId, (k, list) -> {
				list.removeIf(e -> e.type().equals(type) && roomId.equals(e.roomId()));
				return list.isEmpty() ? null : list;
			});
		}
	}

	public boolean isOnline(String userId) {
		return sessions.containsKey(userId);
	}

	public void sendEvent(String toUserId, String type, String fromUserId, Object payload) {
		Set<WebSocketSession> targets = sessions.get(toUserId);
		if (targets == null) {
			return;
		}
		send(targets, new ServerEvent(type, null, fromUserId, null, System.currentTimeMillis(), payload));
	}

	public void sendEvent(String toUserId, ServerEvent event) {
		Set<WebSocketSession> targets = sessions.get(toUserId);
		if (targets != null) {
			send(targets, event);
		}
	}

	/**
	 * Registers the session once {@code authorize} (the membership check) passes. Both run inside the
	 * room's map entry lock, so a concurrent {@link #removeFromRoom} / {@link #closeRoom} (which run after
	 * the membership delete commits) either sees this session and evicts it, or ran first and the check fails.
	 * ponytail: holds the entry lock across one DB read; per-room locks if joins ever contend.
	 */
	@SuppressWarnings("unchecked")
	<T> T joinRoom(String roomId, WebSocketSession session, Supplier<T> authorize) {
		Object[] result = new Object[1];
		rooms.compute(roomId, (k, set) -> {
			result[0] = authorize.get(); // throws for non-members: no mapping change
			Set<WebSocketSession> joined = set != null ? set : ConcurrentHashMap.newKeySet();
			joined.add(session);
			return joined;
		});
		return (T) result[0];
	}


	/**
	 * Runs `action` only if none of the user's connections is in the room, under the room's entry lock (the one
	 * `joinRoom` takes): a join of theirs can't slip in between. A non-null result means the room closed (its
	 * connections are dropped from it); null keeps it. ponytail: holds the entry lock across one DB write.
	 */
	<T> T whileAbsent(String roomId, String userId, Supplier<T> action) {
		Object[] result = {null};
		rooms.compute(roomId, (k, set) -> {
			if (set != null && set.stream().anyMatch(s -> userId.equals(s.getAttributes().get(SocketHandler.USER_ID)))) {
				return set;
			}
			result[0] = action.get();
			if (result[0] != null) {
				forgetHostVideo(roomId); // closed
			}
			return result[0] == null ? set : null;
		});
		@SuppressWarnings("unchecked")
		T out = (T) result[0];
		return out;
	}

	void leaveRoom(String roomId, WebSocketSession session) {
		rooms.computeIfPresent(roomId, (k, set) -> {
			set.remove(session);
			return set.isEmpty() ? null : set;
		});
	}

	/** After a member leaves: their connections stop receiving the room's events. */
	public void removeFromRoom(String roomId, String userId) {
		rooms.computeIfPresent(roomId, (k, set) -> {
			set.removeIf(s -> userId.equals(s.getAttributes().get(SocketHandler.USER_ID)));
			return set.isEmpty() ? null : set;
		});
	}

	public void closeRoom(String roomId) {
		rooms.remove(roomId);
		forgetHostVideo(roomId);
	}

	/** A host's own report: whether their browser shows the room's video. */
	private record Told(String userId, boolean watching) {
	}

	/**
	 * Room → what its host last told (`room:host-video`), and what the room was last told of it. What the room hears is
	 * worked out afresh each time from the current state — the room's host now, whether they are in the room, and
	 * whether this report is theirs — so a late report of a former host, or a leave racing a rejoin, can't leave it
	 * wrong: no host in the room → false; the host's own report → it; else (a 1.1.1 app, a new host) → unknown (null),
	 * which holds no member back. ponytail: in memory, single instance, one lock for every room (these are rare);
	 * a restart forgets it until the host's app tells again (it does on its next join).
	 */
	private final Map<String, Told> told = new ConcurrentHashMap<>();
	private final Map<String, Boolean> heard = new ConcurrentHashMap<>();

	/**
	 * A host's report. Who hosts is looked up again here, under the lock: a report of someone no longer hosting (checked
	 * just before a hand-over, recorded after it) is dropped and never replaces the new host's.
	 */
	public synchronized void hostVideoTold(String roomId, String userId, boolean watching, Supplier<String> host) {
		if (!userId.equals(host.get())) {
			return;
		}
		told.put(roomId, new Told(userId, watching));
		refreshHostVideo(roomId, host);
	}

	/**
	 * The host's connection (back) in the room: their own earlier report goes — unknown until their app tells (a 1.1.1
	 * app never does). Only theirs: a new host's report (handed over meanwhile) stays.
	 */
	public synchronized void hostVideoForgotten(String roomId, String userId, Supplier<String> host) {
		told.computeIfPresent(roomId, (k, t) -> t.userId().equals(userId) ? null : t);
		refreshed(roomId, host);
	}

	/** Worked out again (the host left, or another member hosts now) and told to the room if it changed. */
	public synchronized void refreshHostVideo(String roomId, Supplier<String> host) {
		refreshed(roomId, host);
	}

	/** @return whether the room was told (it changed). */
	private boolean refreshed(String roomId, Supplier<String> host) {
		String hostId = host.get();
		Told t = told.get(roomId);
		Boolean now = hostId == null ? null
				: !presentIn(roomId).contains(hostId) ? Boolean.FALSE
				: t != null && t.userId().equals(hostId) ? Boolean.valueOf(t.watching()) : null;
		Boolean before = now == null ? heard.remove(roomId) : heard.put(roomId, now);
		if (java.util.Objects.equals(before, now)) {
			return false;
		}
		sendToRoom(roomId, hostVideoEvent(roomId, now));
		return true;
	}

	/**
	 * A member's connection just in the room: worked out now (no host in it yet → false), told to the room if that
	 * changed — this connection included — else to it alone, if known.
	 */
	synchronized void sendHostVideo(String roomId, WebSocketSession session, Supplier<String> host) {
		if (refreshed(roomId, host)) {
			return;
		}
		Boolean watching = heard.get(roomId);
		if (watching != null) {
			send(session, hostVideoEvent(roomId, watching));
		}
	}

	private void forgetHostVideo(String roomId) {
		told.remove(roomId);
		heard.remove(roomId);
	}

	/** `room:host-video` `{ watching }` (null: unknown — left out of the JSON). */
	private ServerEvent hostVideoEvent(String roomId, Boolean watching) {
		Map<String, Object> payload = new java.util.HashMap<>();
		payload.put("watching", watching);
		return new ServerEvent("room:host-video", roomId, null, null, System.currentTimeMillis(), payload);
	}

	/** Users with at least one session in the room. */
	public Set<String> presentIn(String roomId) {
		Set<String> ids = new HashSet<>();
		for (WebSocketSession s : rooms.getOrDefault(roomId, Set.of())) {
			ids.add((String) s.getAttributes().get(SocketHandler.USER_ID));
		}
		return ids;
	}

	public void sendToRoom(String roomId, ServerEvent event) {
		Set<WebSocketSession> targets = rooms.get(roomId);
		if (targets != null) {
			send(targets, event);
		}
	}

	void send(WebSocketSession session, ServerEvent event) {
		send(Set.of(session), event);
	}

	private void send(Set<WebSocketSession> targets, ServerEvent event) {
		TextMessage message = new TextMessage(json.writeValueAsString(event));
		for (WebSocketSession s : targets) {
			try {
				s.sendMessage(message);
			} catch (IOException | IllegalStateException e) {
				log.debug("drop message to closed session {}", s.getId());
			}
		}
	}
}
