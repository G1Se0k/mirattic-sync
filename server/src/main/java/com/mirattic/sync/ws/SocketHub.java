package com.mirattic.sync.ws;

import java.io.IOException;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

/**
 * Live sessions per user (a user may be connected from desktop and extension at once),
 * and which sessions have joined which room.
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

	/** @return true if this is the user's first session (they just came online). */
	boolean add(String userId, WebSocketSession session) {
		boolean[] first = {false};
		sessions.compute(userId, (k, set) -> {
			if (set == null) {
				set = ConcurrentHashMap.newKeySet();
				first[0] = true;
			}
			set.add(session);
			return set;
		});
		return first[0];
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
