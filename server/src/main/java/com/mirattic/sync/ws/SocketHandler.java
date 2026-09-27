package com.mirattic.sync.ws;

import com.mirattic.sync.presence.MediaPresence;
import com.mirattic.sync.presence.PresenceService;
import jakarta.validation.Validator;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Component
class SocketHandler extends TextWebSocketHandler {

	private static final Logger log = LoggerFactory.getLogger(SocketHandler.class);

	static final String USER_ID = "userId";
	/** Thread-safe wrapper of the session: fan-out sends from many threads, sendMessage itself is not safe. */
	private static final String OUT = "out";
	private static final String LAST_PRESENCE_AT = "lastPresenceAt";
	private static final long MIN_PRESENCE_INTERVAL_MS = 250;

	private final SocketHub hub;
	private final PresenceService presence;
	private final JsonMapper json;
	private final Validator validator;

	SocketHandler(SocketHub hub, PresenceService presence, JsonMapper json, Validator validator) {
		this.hub = hub;
		this.presence = presence;
		this.json = json;
		this.validator = validator;
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		WebSocketSession out = new ConcurrentWebSocketSessionDecorator(session, 5_000, 256 * 1024);
		session.getAttributes().put(OUT, out);
		if (hub.add(userId(session), out)) {
			presence.online(userId(session));
		}
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		if (hub.remove(userId(session), out(session))) {
			try {
				presence.offline(userId(session));
			} catch (BeansException | IllegalStateException e) {
				// Sessions are closed after JPA during shutdown; nobody is left to notify.
				log.debug("skip offline broadcast: {}", e.getMessage());
			}
		}
	}

	@Override
	protected void handleTextMessage(WebSocketSession session, TextMessage message) {
		JsonNode event;
		try {
			event = json.readTree(message.getPayload());
		} catch (JacksonException e) {
			error(session, null, "bad_json");
			return;
		}
		String type = event.path("type").asString("");
		String reqId = event.path("reqId").isString() ? event.path("reqId").asString() : null;
		// Any client-supplied userId is ignored: identity comes only from the authenticated handshake.
		switch (type) {
			case "presence:update" -> onPresence(session, reqId, event.path("payload"));
			default -> error(session, reqId, "unknown_type");
		}
	}

	private void onPresence(WebSocketSession session, String reqId, JsonNode payload) {
		// ponytail: drops bursts faster than 250ms per session; adapters only send on state changes.
		long now = System.currentTimeMillis();
		Object last = session.getAttributes().get(LAST_PRESENCE_AT);
		if (last instanceof Long at && now - at < MIN_PRESENCE_INTERVAL_MS) {
			error(session, reqId, "rate_limited");
			return;
		}
		session.getAttributes().put(LAST_PRESENCE_AT, now);

		MediaPresence media = null;
		if (!payload.isNull() && !payload.isMissingNode()) {
			try {
				media = json.treeToValue(payload, MediaPresence.class);
			} catch (JacksonException e) {
				error(session, reqId, "bad_payload");
				return;
			}
			if (!validator.validate(media).isEmpty()) {
				error(session, reqId, "bad_payload");
				return;
			}
		}
		presence.update(userId(session), media);
	}

	private void error(WebSocketSession session, String reqId, String code) {
		hub.send(out(session), new ServerEvent("error", null, null, null, System.currentTimeMillis(),
				Map.of("reqId", reqId == null ? "" : reqId, "code", code)));
	}

	private static WebSocketSession out(WebSocketSession session) {
		return (WebSocketSession) session.getAttributes().get(OUT);
	}

	private static String userId(WebSocketSession session) {
		return (String) session.getAttributes().get(USER_ID);
	}
}
