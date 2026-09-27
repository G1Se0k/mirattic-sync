package com.mirattic.sync.ws;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

/** Live sessions per user. A user may be connected from desktop and extension at once. */
@Component
public class SocketHub {

	private static final Logger log = LoggerFactory.getLogger(SocketHub.class);

	private final Map<String, Set<WebSocketSession>> sessions = new ConcurrentHashMap<>();
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
