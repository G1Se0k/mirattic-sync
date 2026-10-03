package com.mirattic.sync.ws;

import com.mirattic.sync.presence.MediaPresence;
import com.mirattic.sync.presence.PresenceService;
import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.PlaybackState;
import com.mirattic.sync.room.RoomContent;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.user.UserRepository;
import jakarta.validation.Validator;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.TaskScheduler;
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
	private static final int MAX_REASON = 200;
	static final long PAUSE_REQUEST_COOLDOWN_MS = 30_000;
	private static final int MAX_PAUSE_REQUEST_ENTRIES = 10_000;

	private final SocketHub hub;
	private final PresenceService presence;
	private final RoomService rooms;
	private final RoomLog roomLog;
	private final UserRepository users;
	private final JsonMapper json;
	private final Validator validator;
	/** "user|room" → when its last pause request went out. ponytail: in memory, single instance; expired ones pruned past 10k. */
	private final Map<String, Long> pauseRequests = new ConcurrentHashMap<>();
	/** "room|host" → when the host's last connection left the room: a later leave restarts the wait. */
	private final Map<String, Long> hostGone = new ConcurrentHashMap<>();
	private final TaskScheduler scheduler;
	private final long hostGoneCloseMs;

	SocketHandler(SocketHub hub, PresenceService presence, RoomService rooms, RoomLog roomLog, UserRepository users, JsonMapper json,
			Validator validator, TaskScheduler scheduler, @Value("${app.host-gone-close-ms:30000}") long hostGoneCloseMs) {
		this.scheduler = scheduler;
		this.hostGoneCloseMs = hostGoneCloseMs;
		this.hub = hub;
		this.users = users;
		this.presence = presence;
		this.rooms = rooms;
		this.roomLog = roomLog;
		this.json = json;
		this.validator = validator;
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		WebSocketSession out = new ConcurrentWebSocketSessionDecorator(session, 5_000, 256 * 1024);
		session.getAttributes().put(OUT, out);
		session.getAttributes().put(JOINED_ROOMS, ConcurrentHashMap.newKeySet());
		boolean first = hub.add(userId(session), out);
		// Checked after the add: an account deleted meanwhile either closed this session (hub.disconnect) or is
		// gone from the database by now. A ticket issued just before the deletion can't leave a session behind.
		if (!users.existsById(userId(session))) {
			hub.disconnect(userId(session));
			return;
		}
		hub.sendKept(userId(session)); // e.g. rooms closed while this user was offline (decision 90)
		if (first) {
			presence.online(userId(session));
		}
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		boolean offline = hub.remove(userId(session), out(session));
		try {
			for (String roomId : joined(session)) {
				hub.leaveRoom(roomId, out(session));
				rooms.read(userId(session), roomId);
				pauseIfHostGone(userId(session), roomId);
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
		// One at a time per user, and never across a device switch (SocketHub.add takes the same lock): a frame
		// either finishes before the new device takes over or, from the replaced one, counts for nothing.
		synchronized (hub.lockFor(userId(session))) {
			if (!hub.isCurrent(userId(session), out(session))) {
				return;
			}
			handle(session, message);
		}
	}

	private void handle(WebSocketSession session, TextMessage message) {
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
			case "room:closed:ack" -> {
				// The app has the notice of this closed room (decision 90): not sent again.
				if (roomId != null) {
					hub.acknowledge(userId(session), "room:closed", roomId);
				}
			}
			case "sync:request" -> hub.send(out(session), new ServerEvent("sync:response", null, null, null,
					System.currentTimeMillis(), Map.of("reqId", reqId == null ? "" : reqId)));
			case "room:join", "room:leave", "playback:play", "playback:pause", "playback:seek",
					"playback:content-change", "chat:message", "pause:request", "room:read" -> {
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
				PlaybackState state = hub.joinRoom(roomId, out(session), () -> {
					PlaybackState s = rooms.join(me, roomId);
					// Back in: an earlier leave's wait is over. Under the entry lock, so a disconnect's new wait (made
					// after its leaveRoom, which takes the same lock) can't be cleared by this join.
					hostGone.remove(roomId + "|" + me);
					return s;
				});
				joined(session).add(roomId);
				roomLog.joined(roomId, me);
				rooms.read(me, roomId); // outside joinRoom: never wait on the room row lock inside the hub's entry lock
				hub.send(out(session), playbackEvent(roomId, state));
				rooms.announce(roomId, rooms.memberIds(roomId));
			}
			case "room:leave" -> {
				if (joined(session).remove(roomId)) {
					hub.leaveRoom(roomId, out(session));
					rooms.read(me, roomId);
					pauseIfHostGone(me, roomId);
					rooms.announce(roomId, rooms.memberIds(roomId));
				}
			}
			case "room:read" -> {
				// The extension stays joined with its panel closed: it marks what the user actually saw.
				rooms.requireMembership(me, roomId);
				rooms.read(me, roomId);
				rooms.announce(roomId, List.of(me)); // my other apps refetch their counts
			}
			case "pause:request" -> {
				JsonNode reason = payload.path("reason");
				if (!(reason.isMissingNode() || reason.isNull() || reason.isString() && reason.asString().length() <= MAX_REASON)) {
					error(session, reqId, "bad_payload");
					return;
				}
				String host = rooms.hostToAsk(me, roomId);
				// One request per member and room every 30 seconds.
				long now = System.currentTimeMillis();
				if (pauseRequests.size() > MAX_PAUSE_REQUEST_ENTRIES) {
					pauseRequests.values().removeIf(at -> now - at >= PAUSE_REQUEST_COOLDOWN_MS);
				}
				// Checked and taken in one step per key: concurrent requests from two connections can't both pass.
				boolean[] allowed = {false};
				pauseRequests.compute(me + "|" + roomId, (k, last) -> {
					if (last != null && now - last < PAUSE_REQUEST_COOLDOWN_MS) {
						return last;
					}
					allowed[0] = true;
					return now;
				});
				if (!allowed[0]) {
					error(session, reqId, "rate_limited");
					return;
				}
				String text = reason.isString() ? reason.asString().strip() : "";
				hub.sendEvent(host, new ServerEvent("pause:request", roomId, me, null, now, Map.of("reason", text)));
			}
			case "chat:message" -> {
				if (!withinBudget(session, CHAT_WINDOW, MAX_CHAT_PER_SECOND)) {
					error(session, reqId, "rate_limited");
					return;
				}
				JsonNode text = payload.path("text");
				JsonNode position = payload.path("mediaPositionMs");
				if (!text.isString() || !(position.isMissingNode() || position.isNull() || position.canConvertToLong())) {
					error(session, reqId, "bad_payload");
					return;
				}
				ChatMessage.View message = rooms.chat(me, roomId, text.asString(),
						position.canConvertToLong() ? position.asLong() : null);
				// To every member, live in the room or not: the others count it as unread (and may be notified).
				ServerEvent event = new ServerEvent("chat:message", roomId, me, null, message.createdAt(), message);
				rooms.memberIds(roomId).forEach(id -> hub.sendEvent(id, event));
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
				synchronized (roomLog.order(roomId)) { // logged in the order applied
					RoomService.Changed changed = rooms.changeContent(me, roomId, content);
					if (changed != null) {
						hub.sendToRoom(roomId, playbackEvent(roomId, changed.state()));
						roomLog.contentChanged(roomId, changed.state().version(), changed.log());
						if (changed.type() != null) {
							rooms.announceType(roomId);
						}
					}
				}
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
				// Whether the host is holding the seek bar (decision 86); absent where the page can't tell.
				JsonNode scrub = payload.path("scrubbing");
				Boolean scrubbing = scrub.isBoolean() ? scrub.asBoolean() : null;
				// Applied and logged in one order per room (two host connections at once): the log sees every
				// transition in version order. Delivery order across threads isn't guaranteed; clients drop
				// versions they've passed.
				synchronized (roomLog.order(roomId)) {
					RoomService.Applied applied = rooms.playback(me, roomId, command, position.asLong(), capturedAt.asLong());
					hub.sendToRoom(roomId, playbackEvent(roomId, applied.state()));
					roomLog.playback(roomId, me, applied, scrubbing);
				}
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

	/** With none of the host's connections left in the room, the members are paused (plan.md decision 67). */
	private void pauseIfHostGone(String userId, String roomId) {
		BooleanSupplier stillThere = () -> hub.presentIn(roomId).contains(userId); // e.g. from another app
		if (stillThere.getAsBoolean()) {
			return;
		}
		PlaybackState state = rooms.hostLeft(userId, roomId, stillThere);
		if (state != null) {
			hub.sendToRoom(roomId, playbackEvent(roomId, state));
		}
		if (rooms.isHost(userId, roomId)) {
			closeIfHostStaysAway(userId, roomId);
		}
	}

	/**
	 * The host left the room (panel or window closed, room screen left, connection lost): unless one of their
	 * connections is back in it after `hostGoneCloseMs` — a reconnect or worker restart — the room closes and the
	 * members are told (decision 90). ponytail: in memory, single instance; a restart forgets the wait (the empty-room
	 * sweep closes it if nobody is left).
	 */
	private void closeIfHostStaysAway(String hostId, String roomId) {
		String key = roomId + "|" + hostId;
		long leftAt = System.nanoTime();
		// Marked under the room's entry lock, only while still away: a join (which clears marks under the same lock)
		// either came first — no wait — or comes after and clears this one.
		hub.whileAbsent(roomId, hostId, () -> {
			hostGone.put(key, leftAt);
			return null;
		});
		if (!Long.valueOf(leftAt).equals(hostGone.get(key))) {
			return; // back in already
		}
		scheduler.schedule(() -> {
			// Under the same lock: still away, and this is still their latest leave (a join clears it, a later leave
			// replaces it with its own wait).
			RoomService.Left left = hub.whileAbsent(roomId, hostId,
					() -> hostGone.remove(key, leftAt) ? rooms.closeHostedBy(hostId, roomId) : null);
			if (left != null) {
				rooms.announceClosed(roomId, hostId, left);
			}
		}, Instant.now().plusMillis(hostGoneCloseMs));
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
