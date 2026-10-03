package com.mirattic.sync.room;

import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.ws.RoomLog;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import com.mirattic.sync.user.UserSummary;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

	/** `content` null: no video yet (decision 92). */
	record CreateRoom(@Valid RoomContent content, @NotNull @Size(max = 32) List<String> inviteIds) {
	}

	record Invite(@NotNull @Size(min = 1, max = 32) List<String> userIds) {
	}

	record WatchRequest(@NotBlank String friendId) {
	}

	record Mute(@NotNull Boolean muted) {
	}

	record HandOver(@NotBlank String userId) {
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
	/**
	 * "requester>friend" → when a request was sent and not taken back: only such a request can be cancelled, once,
	 * so repeated cancels send nothing. A request counts for `OPEN_WATCH_REQUEST_MS` (decision 87): listed and
	 * answerable by an invite until then. ponytail: in memory, forgotten on a restart.
	 */
	final Map<String, Long> openWatchRequests = new ConcurrentHashMap<>(); // package: tests age requests
	static final long OPEN_WATCH_REQUEST_MS = 30_000;

	/** A friend's watch request to me, with its time left (decision 87). */
	record IncomingRequest(String id, String displayName, long expiresInMs) {
	}
	/**
	 * Orders answering a watch request (an invite, through its room write) against cancelling it.
	 * ponytail: one lock for every create/invite on this instance; per-pair locks if invites ever get busy.
	 */
	private final Object answerLock = new Object();

	private final RoomService rooms;
	private final SocketHub hub;
	private final RoomLog roomLog;

	RoomController(RoomService rooms, SocketHub hub, RoomLog roomLog) {
		this.rooms = rooms;
		this.hub = hub;
		this.roomLog = roomLog;
	}

	/**
	 * Creates a room hosted by the caller; invitees get an invitation (`room:invite`, decision 85), except those
	 * whose watch request this answers: members at once, with `watch:answer`.
	 */
	@PostMapping
	RoomService.RoomView create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateRoom body) {
		String me = jwt.getSubject();
		synchronized (answerLock) {
			Map<String, Long> answering = answering(me, body.inviteIds());
			RoomService.RoomView room;
			try {
				room = rooms.create(me, body.content(), body.inviteIds(), answering.keySet());
			} catch (RuntimeException e) {
				unclaim(me, answering);
				throw e;
			}
			sendInvites(me, room, List.of(me), body.inviteIds(), answering.keySet());
			return room;
		}
	}

	/** Host invites more friends: invitations (or membership, answering a watch request); members get `room:update`. */
	@PostMapping("/{id}/invites")
	RoomService.RoomView invite(@AuthenticationPrincipal Jwt jwt, @PathVariable String id,
			@Valid @RequestBody Invite body) {
		String me = jwt.getSubject();
		RoomService.Invited invited;
		synchronized (answerLock) {
			Map<String, Long> answering = answering(me, body.userIds());
			try {
				invited = rooms.invite(me, id, body.userIds(), answering.keySet());
			} catch (RuntimeException e) {
				unclaim(me, answering);
				throw e;
			}
			sendInvites(me, invited.room(), invited.before(), body.userIds(), answering.keySet());
		}
		rooms.announce(id, invited.before());
		return invited.room();
	}

	/** The rooms inviting me (decision 85), for a panel opened after the `room:invite`. */
	@GetMapping("/invitations")
	List<RoomService.RoomView> invitations(@AuthenticationPrincipal Jwt jwt) {
		return rooms.invitations(jwt.getSubject());
	}

	/** Accepts the room's invitation: now a member; the members get `room:update`. 404 without one, 409 full. */
	@PostMapping("/{id}/invitation")
	RoomService.RoomView accept(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		RoomService.Invited joined = rooms.accept(jwt.getSubject(), id);
		if (!joined.before().contains(jwt.getSubject())) {
			rooms.announce(id, joined.before());
		}
		answered(jwt.getSubject(), id);
		return joined.room();
	}

	/** Declines the room's invitation. */
	@DeleteMapping("/{id}/invitation")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void decline(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		rooms.decline(jwt.getSubject(), id);
		answered(jwt.getSubject(), id);
	}

	/** My other apps drop the invitation's banner (and list the room if I accepted): they reload on `room:update`. */
	private void answered(String me, String roomId) {
		hub.sendEvent(me, new ServerEvent("room:update", roomId, me, null, System.currentTimeMillis(), null));
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
	Asked requestWatch(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody WatchRequest body) {
		UserSummary me = rooms.requestWatch(jwt.getSubject(), body.friendId());
		rooms.requireApart(me.id(), body.friendId());
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
		openWatchRequests.values().removeIf(at -> now - at >= OPEN_WATCH_REQUEST_MS);
		openWatchRequests.put(me.id() + ">" + body.friendId(), now);
		hub.sendEvent(body.friendId(), new ServerEvent("watch:request", null, me.id(), null, now,
				new IncomingRequest(me.id(), me.displayName(), OPEN_WATCH_REQUEST_MS)));
		return new Asked(now);
	}

	/**
	 * Which request this is (when it was made): a `watch:decline` names the request it declines, so a late one for
	 * an earlier request can't clear a newer one.
	 */
	record Asked(long askedAt) {
	}

	/**
	 * Takes back my watch request to a friend: they get `watch:cancel` (and drop its banner) — once, and only for a
	 * request still open, so repeating it sends nothing. Friends only, like the request; the 30 s limit on asking
	 * again stays, so cancel + ask can't be used to flood.
	 */
	@DeleteMapping("/requests/{friendId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void cancelWatchRequest(@AuthenticationPrincipal Jwt jwt, @PathVariable String friendId) {
		UserSummary me = rooms.requestWatch(jwt.getSubject(), friendId);
		Long removed;
		synchronized (answerLock) { // after an invite answering it: gone (answered) or back (the invite failed)
			removed = openWatchRequests.remove(me.id() + ">" + friendId);
		}
		if (removed != null) {
			hub.sendEvent(friendId, new ServerEvent("watch:cancel", null, me.id(), null, System.currentTimeMillis(), me));
		}
	}

	/**
	 * Claims the invitees' open watch requests to me (not older than the hour; older ones stay for their cancel)
	 * that this invite answers. Called holding `answerLock` through the invite, like a cancel, so a cancel either
	 * came first (no request: an invitation instead) or comes after (answered: nothing to cancel; failed: put
	 * back, so the cancel still tells the friend).
	 */
	private Map<String, Long> answering(String hostId, List<String> invitees) {
		long now = System.currentTimeMillis();
		Map<String, Long> claimed = new HashMap<>();
		for (String id : invitees) {
			String key = id + ">" + hostId;
			Long askedAt = openWatchRequests.get(key);
			if (!id.equals(hostId) && askedAt != null && now - askedAt < OPEN_WATCH_REQUEST_MS) {
				openWatchRequests.remove(key);
				claimed.put(id, askedAt);
			}
		}
		return claimed;
	}

	private void unclaim(String hostId, Map<String, Long> claimed) {
		claimed.forEach((id, at) -> openWatchRequests.put(id + ">" + hostId, at));
	}

	/**
	 * After a create or invite: `room:invite` (an invitation) to the invitees who weren't members; those whose
	 * watch request it answered (members now, or already) get `watch:answer` instead and their request is closed.
	 */
	private void sendInvites(String hostId, RoomService.RoomView room, List<String> alreadyIn, List<String> invitedIds,
			Set<String> answered) {
		long now = System.currentTimeMillis();
		for (String id : new LinkedHashSet<>(invitedIds)) {
			if (id.equals(hostId)) {
				continue;
			}
			if (answered.contains(id)) {
				hub.sendEvent(id, new ServerEvent("watch:answer", room.id(), hostId, null, now, null));
			} else if (!alreadyIn.contains(id)) {
				hub.sendEvent(id, new ServerEvent("room:invite", room.id(), hostId, null, now,
						room.expiring(RoomService.INVITATION_MS)));
			}
		}
	}

	/** The friends I asked to watch together whose answer I still wait for (a reopened panel gets them back). */
	@GetMapping("/requests")
	List<String> openWatchRequests(@AuthenticationPrincipal Jwt jwt) {
		String prefix = jwt.getSubject() + ">";
		long now = System.currentTimeMillis();
		return openWatchRequests.entrySet().stream()
				.filter(e -> e.getKey().startsWith(prefix) && now - e.getValue() < OPEN_WATCH_REQUEST_MS)
				.map(e -> e.getKey().substring(prefix.length()))
				.toList();
	}

	/** My watch requests still waiting, each with its time left (a reopened panel shows how long). */
	@GetMapping("/requests/outgoing")
	List<OutgoingRequest> outgoingWatchRequests(@AuthenticationPrincipal Jwt jwt) {
		String prefix = jwt.getSubject() + ">";
		long now = System.currentTimeMillis();
		return openWatchRequests.entrySet().stream()
				.filter(e -> e.getKey().startsWith(prefix) && now - e.getValue() < OPEN_WATCH_REQUEST_MS)
				.map(e -> new OutgoingRequest(e.getKey().substring(prefix.length()), OPEN_WATCH_REQUEST_MS - (now - e.getValue()),
						e.getValue()))
				.toList();
	}

	/** A watch request of mine to a friend, with its time left. */
	record OutgoingRequest(String friendId, long expiresInMs, long askedAt) {
	}

	/**
	 * Friends' watch requests to me still open (not answered, cancelled or dismissed, still in time), with the
	 * time left: a panel opened after the `watch:request` shows them again.
	 */
	@GetMapping("/requests/incoming")
	List<IncomingRequest> incomingWatchRequests(@AuthenticationPrincipal Jwt jwt) {
		String suffix = ">" + jwt.getSubject();
		long now = System.currentTimeMillis();
		Map<String, Long> askedAt = new HashMap<>();
		openWatchRequests.forEach((key, at) -> {
			if (key.endsWith(suffix) && now - at < OPEN_WATCH_REQUEST_MS) {
				askedAt.put(key.substring(0, key.length() - suffix.length()), at);
			}
		});
		return rooms.friendsAmong(jwt.getSubject(), List.copyOf(askedAt.keySet())).stream()
				.map(u -> new IncomingRequest(u.id(), u.displayName(), OPEN_WATCH_REQUEST_MS - (now - askedAt.get(u.id()))))
				.toList();
	}

	/**
	 * Dismisses a friend's watch request to me ("무시"): it no longer comes back, and a later invite doesn't count
	 * as its answer. The requester is told (`watch:decline`, userId = me); they may ask again after the 30 s limit.
	 */
	@DeleteMapping("/requests/incoming/{friendId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void dismissWatchRequest(@AuthenticationPrincipal Jwt jwt, @PathVariable String friendId) {
		Long removed;
		synchronized (answerLock) {
			removed = openWatchRequests.remove(friendId + ">" + jwt.getSubject());
		}
		// The requester's panel shows it was declined: once (a second dismissal sends nothing), and only while it
		// still counted (an expired one just goes).
		if (removed != null && System.currentTimeMillis() - removed < OPEN_WATCH_REQUEST_MS) {
			hub.sendEvent(friendId, new ServerEvent("watch:decline", null, jwt.getSubject(), null, System.currentTimeMillis(),
					new Asked(removed)));
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
		// After the commit, to my own connections only. The new value rides along, so they apply
		// it before their refetch returns and no message notifies by the old setting meanwhile.
		hub.sendEvent(jwt.getSubject(), new ServerEvent("room:update", id, null, null, System.currentTimeMillis(),
				Map.of("muted", body.muted())));
	}

	/**
	 * The host removes a member (decision 79): their connections leave the room at once, everyone (them included)
	 * refetches; the removed member then gets 404 and is back on their list. 403 not host, 400 self, 404 not a member.
	 */
	@DeleteMapping("/{id}/members/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void kick(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @PathVariable String userId) {
		RoomService.Logged kicked = rooms.kick(jwt.getSubject(), id, userId);
		hub.removeFromRoom(id, userId);
		roomLog.forget(id, userId);
		roomLog.post(id, kicked.log());
		rooms.announce(id, kicked.memberIds());
	}

	record SetType(@NotNull MediaProvider type) {
	}

	/** The host picks the room's type (decision 93): the members are told (`room:type`) and the room refetched. */
	@PutMapping("/{id}/type")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void setType(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @Valid @RequestBody SetType body) {
		List<String> told = rooms.setType(jwt.getSubject(), id, body.type());
		if (told != null) {
			rooms.announceType(id);
			rooms.announce(id, told);
		}
	}

	record SeeType(long version) {
	}

	/** A member confirmed the room's type change up to `version` (decision 93): not asked again. */
	@PostMapping("/{id}/type/seen")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void seeType(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @RequestBody SeeType body) {
		rooms.seeType(jwt.getSubject(), id, body.version());
	}

	/** The host makes another member the host (decision 79); they become a member. */
	@PostMapping("/{id}/host")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void handOver(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @Valid @RequestBody HandOver body) {
		RoomService.Logged handed = rooms.handOver(jwt.getSubject(), id, body.userId());
		roomLog.post(id, handed.log());
		rooms.announce(id, handed.memberIds());
	}

	/** Leave (or decline an invite). The host leaving closes the room; members then get 404 on refetch. */
	record Back(boolean closed) {
	}

	record BackRequest(boolean confirmed) {
	}

	/**
	 * Back from the room screen (decision 90): the host's closes the room (`room:closed` to the members) once
	 * `confirmed`, 409 before; a member's does nothing.
	 */
	@PostMapping("/{id}/back")
	Back back(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @RequestBody(required = false) BackRequest body) {
		RoomService.Left left = rooms.back(jwt.getSubject(), id, body != null && body.confirmed());
		if (left == null) {
			return new Back(false);
		}
		hub.closeRoom(id);
		rooms.announceClosed(id, jwt.getSubject(), left);
		return new Back(true);
	}

	@DeleteMapping("/{id}/members/me")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void leave(@AuthenticationPrincipal Jwt jwt, @PathVariable String id, @RequestParam(defaultValue = "false") boolean asMember) {
		RoomService.Left left = rooms.leave(jwt.getSubject(), id, asMember);
		if (left.closed()) {
			hub.closeRoom(id);
			rooms.announceClosed(id, jwt.getSubject(), left);
			return;
		}
		hub.removeFromRoom(id, jwt.getSubject());
		rooms.announce(id, left.memberIds());
	}
}
