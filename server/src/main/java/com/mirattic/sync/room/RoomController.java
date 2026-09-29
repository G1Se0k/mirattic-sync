package com.mirattic.sync.room;

import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import com.mirattic.sync.user.UserSummary;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/rooms")
class RoomController {

	record CreateRoom(@NotNull @Valid RoomContent content, @NotNull @Size(max = 32) List<String> inviteIds) {
	}

	record Invite(@NotNull @Size(min = 1, max = 32) List<String> userIds) {
	}

	record WatchRequest(@NotBlank String friendId) {
	}

	record Mute(@NotNull Boolean muted) {
	}

	record JoinByCode(@NotBlank @Size(max = 16) String code) {
	}

	/** Code attempts per user in any 60 s: a code can't be found by trying (decision 77). */
	static final int MAX_CODE_ATTEMPTS_PER_MINUTE = 10;
	// ponytail: in-memory, pruned past 10k users; single server, like the other limits.
	private final Map<String, Deque<Long>> codeAttempts = new ConcurrentHashMap<>();

	/** One watch request per (requester, friend) per this interval. */
	static final long WATCH_REQUEST_INTERVAL_MS = 30_000;
	// ponytail: in-memory, pruned on each request (O(pairs asked in the last 30s)); single server, like presence.
	private final Map<String, Long> lastWatchRequest = new ConcurrentHashMap<>();

	private final RoomService rooms;
	private final SocketHub hub;

	RoomController(RoomService rooms, SocketHub hub) {
		this.rooms = rooms;
		this.hub = hub;
	}

	/** Creates a room hosted by the caller; invitees get `room:invite` with the room. */
	@PostMapping
	RoomService.RoomView create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateRoom body) {
		RoomService.RoomView room = rooms.create(jwt.getSubject(), body.content(), body.inviteIds());
		sendInvites(jwt.getSubject(), room, List.of(jwt.getSubject()));
		return room;
	}

	/** Host invites more friends; they get `room:invite`, current members `room:update`. */
	@PostMapping("/{id}/invites")
	RoomService.RoomView invite(@AuthenticationPrincipal Jwt jwt, @PathVariable String id,
			@Valid @RequestBody Invite body) {
		RoomService.Invited invited = rooms.invite(jwt.getSubject(), id, body.userIds());
		sendInvites(jwt.getSubject(), invited.room(), invited.before());
		rooms.announce(id, invited.before());
		return invited.room();
	}

	/**
	 * Asks a friend to start (or open) a room with the caller: the friend gets `watch:request` with the caller,
	 * and answers by inviting them. 409 if the friend is offline (nobody would see it), 429 if asked recently.
	 */
	/** Joins the room with this code (anyone who knows it); its members get `room:update`. */
	@PostMapping("/join")
	RoomService.RoomView joinByCode(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody JoinByCode body) {
		String me = jwt.getSubject();
		long now = System.currentTimeMillis();
		if (codeAttempts.size() > 10_000) {
			codeAttempts.values().removeIf(times -> now - times.peekLast() >= 60_000);
		}
		boolean[] allowed = {false};
		// Sliding 60 s: check and record in one atomic step; refused attempts aren't recorded.
		codeAttempts.compute(me, (k, times) -> {
			Deque<Long> t = times == null ? new ArrayDeque<>() : times;
			while (!t.isEmpty() && now - t.peekFirst() >= 60_000) {
				t.pollFirst();
			}
			allowed[0] = t.size() < MAX_CODE_ATTEMPTS_PER_MINUTE;
			if (allowed[0]) {
				t.addLast(now);
			}
			return t.isEmpty() ? null : t;
		});
		if (!allowed[0]) {
			throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
		}
		RoomService.Invited joined = rooms.joinByCode(me, body.code());
		if (!joined.before().contains(me)) {
			rooms.announce(joined.room().id(), joined.before());
		}
		return joined.room();
	}

	@PostMapping("/requests")
	@ResponseStatus(HttpStatus.ACCEPTED)
	void requestWatch(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody WatchRequest body) {
		UserSummary me = rooms.requestWatch(jwt.getSubject(), body.friendId());
		if (!hub.isOnline(body.friendId())) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, "friend is offline");
		}
		long now = System.currentTimeMillis();
		boolean[] allowed = {false};
		lastWatchRequest.values().removeIf(at -> now - at >= WATCH_REQUEST_INTERVAL_MS); // expired
		// Check and record in one atomic step, or concurrent requests would all pass.
		lastWatchRequest.compute(me.id() + ">" + body.friendId(), (k, last) -> {
			allowed[0] = last == null || now - last >= WATCH_REQUEST_INTERVAL_MS;
			return allowed[0] ? now : last;
		});
		if (!allowed[0]) {
			throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
		}
		hub.sendEvent(body.friendId(), new ServerEvent("watch:request", null, me.id(), null, now, me));
	}

	/** `room:invite`, once each, to the room's members who aren't in `alreadyIn`. */
	private void sendInvites(String hostId, RoomService.RoomView room, List<String> alreadyIn) {
		ServerEvent invite = new ServerEvent("room:invite", room.id(), hostId, null, System.currentTimeMillis(), room);
		for (RoomService.MemberView m : room.members()) {
			if (!alreadyIn.contains(m.user().id())) {
				hub.sendEvent(m.user().id(), invite);
			}
		}
	}

	@GetMapping
	List<RoomService.RoomView> mine(@AuthenticationPrincipal Jwt jwt) {
		return rooms.mine(jwt.getSubject());
	}

	@GetMapping("/{id}")
	RoomService.RoomView get(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		return rooms.get(jwt.getSubject(), id);
	}

	/** 100 chat messages, oldest first: the latest, or those before message `before`. New ones arrive as `chat:message`. */
	@GetMapping("/{id}/messages")
	List<ChatMessage.View> messages(@AuthenticationPrincipal Jwt jwt, @PathVariable String id,
			@RequestParam(required = false) String before) {
		return rooms.history(jwt.getSubject(), id, before);
	}

	/** Author or host: deletes the message; every member's connections get `chat:delete {id}`. */
	@DeleteMapping("/{id}/messages/{messageId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void deleteMessage(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @PathVariable String messageId) {
		rooms.deleteMessage(jwt.getSubject(), id, messageId);
		ServerEvent event = new ServerEvent("chat:delete", id, jwt.getSubject(), null, System.currentTimeMillis(),
				Map.of("id", messageId));
		rooms.memberIds(id).forEach(member -> hub.sendEvent(member, event));
	}

	/** My chat notifications for this room. */
	@PutMapping("/{id}/members/me/muted")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void mute(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @Valid @RequestBody Mute body) {
		rooms.mute(jwt.getSubject(), id, body.muted());
		// After the commit, to my other apps (desktop / extension) only. The new value rides along, so they apply
		// it before their refetch returns and no message notifies by the old setting meanwhile.
		hub.sendEvent(jwt.getSubject(), new ServerEvent("room:update", id, null, null, System.currentTimeMillis(),
				Map.of("muted", body.muted())));
	}

	/** Leave (or decline an invite). The host leaving closes the room; members then get 404 on refetch. */
	@DeleteMapping("/{id}/members/me")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void leave(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		RoomService.Left left = rooms.leave(jwt.getSubject(), id);
		if (left.closed()) {
			hub.closeRoom(id);
		} else {
			hub.removeFromRoom(id, jwt.getSubject());
		}
		rooms.announce(id, left.memberIds());
	}
}
