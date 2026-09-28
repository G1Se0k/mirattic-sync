package com.mirattic.sync.ws;

import com.mirattic.sync.presence.MediaPresence;
import com.mirattic.sync.presence.PresenceService;
import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.PlaybackState;
import com.mirattic.sync.room.RoomContent;
import com.mirattic.sync.room.RoomService;
import jakarta.validation.Validator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionException;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.server.ResponseStatusException;
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
	private static final String JOINED_ROOMS = "rooms";
	private static final String PLAYBACK_WINDOW = "playbackWindow";
	/**
	 * Flood guard only: hosts coalesce to ~5/s (`publishHost`). A per-second budget instead of a minimum
	 * gap, so jitter that bunches two legit commands together never drops the latest one.
	 */
	private static final int MAX_PLAYBACK_PER_SECOND = 20;
	private static final String CHAT_WINDOW = "chatWindow";
	private static final int MAX_CHAT_PER_SECOND = 5;

	private final SocketHub hub;
	private final PresenceService presence;
	private final RoomService rooms;
	private final JsonMapper json;
	private final Validator validator;

	SocketHandler(SocketHub hub, PresenceService presence, RoomService rooms, JsonMapper json, Validator validator) {
		this.hub = hub;
		this.presence = presence;
		this.rooms = rooms;
		this.json = json;
		this.validator = validator;
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		WebSocketSession out = new ConcurrentWebSocketSessionDecorator(session, 5_000, 256 * 1024);
		session.getAttributes().put(OUT, out);
		session.getAttributes().put(JOINED_ROOMS, ConcurrentHashMap.newKeySet());
		if (hub.add(userId(session), out)) {
			presence.online(userId(session));
		}
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		boolean offline = hub.remove(userId(session), out(session));
		try {
			for (String roomId : joined(session)) {
				hub.leaveRoom(roomId, out(session));
				rooms.announce(roomId, rooms.memberIds(roomId));
			}
			if (offline) {
				presence.offline(userId(session));
			}
		} catch (BeansException | IllegalStateException | TransactionException e) {
			// Sessions are closed after JPA during shutdown; nobody is left to notify.
			log.debug("skip disconnect broadcast: {}", e.getMessage());
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
		String roomId = event.path("roomId").isString() ? event.path("roomId").asString() : null;
		// Any client-supplied userId is ignored: identity comes only from the authenticated handshake.
		switch (type) {
			case "presence:update" -> onPresence(session, reqId, event.path("payload"));
			case "sync:request" -> hub.send(out(session), new ServerEvent("sync:response", null, null, null,
					System.currentTimeMillis(), Map.of("reqId", reqId == null ? "" : reqId)));
			case "room:join", "room:leave", "playback:play", "playback:pause", "playback:seek",
					"playback:content-change", "chat:message" -> {
				if (roomId == null) {
					error(session, reqId, "bad_payload");
					return;
				}
				try {
					onRoomEvent(session, reqId, type, roomId, event.path("payload"));
				} catch (ResponseStatusException e) {
					error(session, reqId, switch (e.getStatusCode().value()) {
						case 400 -> "bad_payload";
						case 403 -> "not_host";
						default -> "not_member";
					});
				}
			}
			default -> error(session, reqId, "unknown_type");
		}
	}

	private void onRoomEvent(WebSocketSession session, String reqId, String type, String roomId, JsonNode payload) {
		String me = userId(session);
		switch (type) {
			case "room:join" -> {
				PlaybackState state = hub.joinRoom(roomId, out(session), () -> rooms.join(me, roomId));
				joined(session).add(roomId);
				hub.send(out(session), playbackEvent(roomId, state));
				rooms.announce(roomId, rooms.memberIds(roomId));
			}
			case "room:leave" -> {
				if (joined(session).remove(roomId)) {
					hub.leaveRoom(roomId, out(session));
					rooms.announce(roomId, rooms.memberIds(roomId));
				}
			}
			case "chat:message" -> {
				if (!withinBudget(session, CHAT_WINDOW, MAX_CHAT_PER_SECOND)) {
					error(session, reqId, "rate_limited");
					return;
				}
				JsonNode position = payload.path("mediaPositionMs");
				if (!payload.path("text").isString() || !(position.isMissingNode() || position.isNull() || position.canConvertToLong())) {
					error(session, reqId, "bad_payload");
					return;
				}
				ChatMessage.View message = rooms.chat(me, roomId, payload.path("text").asString(),
						position.canConvertToLong() ? position.asLong() : null);
				hub.sendToRoom(roomId, new ServerEvent("chat:message", roomId, me, null, message.createdAt(), message));
			}
			case "playback:content-change" -> {
				if (!withinBudget(session, PLAYBACK_WINDOW, MAX_PLAYBACK_PER_SECOND)) {
					error(session, reqId, "rate_limited");
					return;
				}
				RoomContent content = parse(session, reqId, payload, RoomContent.class);
				if (content == null) {
					return;
				}
				PlaybackState state = rooms.changeContent(me, roomId, content);
				hub.sendToRoom(roomId, playbackEvent(roomId, state));
				rooms.announce(roomId, rooms.memberIds(roomId)); // members refetch the room's new content
			}
			default -> {
				if (!withinBudget(session, PLAYBACK_WINDOW, MAX_PLAYBACK_PER_SECOND)) {
					error(session, reqId, "rate_limited");
					return;
				}
				JsonNode position = payload.path("positionMs");
				JsonNode capturedAt = payload.path("capturedAt");
				if (!position.canConvertToLong() || position.asLong() < 0 || !capturedAt.canConvertToLong()) {
					error(session, reqId, "bad_payload");
					return;
				}
				RoomService.Command command = RoomService.Command.valueOf(
						type.substring("playback:".length()).toUpperCase(Locale.ROOT));
				PlaybackState state = rooms.playback(me, roomId, command, position.asLong(), capturedAt.asLong());
				// Delivery order across threads isn't guaranteed; clients drop versions they've passed.
				hub.sendToRoom(roomId, playbackEvent(roomId, state));
			}
		}
	}

	/** Fixed one-second window per session: [windowStart, count]. Handler calls per session are sequential. */
	private static boolean withinBudget(WebSocketSession session, String key, int max) {
		long now = System.currentTimeMillis();
		long[] window = (long[]) session.getAttributes().computeIfAbsent(key, k -> new long[] {now, 0});
		if (now - window[0] >= 1000) {
			window[0] = now;
			window[1] = 0;
		}
		return ++window[1] <= max;
	}

	private static ServerEvent playbackEvent(String roomId, PlaybackState state) {
		return new ServerEvent("playback:update", roomId, state.sourceUserId(), state.version(),
				System.currentTimeMillis(), state);
	}

	@SuppressWarnings("unchecked")
	private static Set<String> joined(WebSocketSession session) {
		return (Set<String>) session.getAttributes().get(JOINED_ROOMS);
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
			media = parse(session, reqId, payload, MediaPresence.class);
			if (media == null) {
				return;
			}
		}
		presence.update(userId(session), media);
	}

	/** Reads and validates a payload; answers `bad_payload` and returns null if it isn't one. */
	private <T> T parse(WebSocketSession session, String reqId, JsonNode payload, Class<T> type) {
		T value;
		try {
			value = json.treeToValue(payload, type);
		} catch (JacksonException e) {
			value = null;
		}
		if (value == null || !validator.validate(value).isEmpty()) {
			error(session, reqId, "bad_payload");
			return null;
		}
		return value;
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
