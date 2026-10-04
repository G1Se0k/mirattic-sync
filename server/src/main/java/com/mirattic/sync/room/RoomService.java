package com.mirattic.sync.room;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.FriendCode;
import com.mirattic.sync.friend.BlockRepository;
import com.mirattic.sync.user.UserSummary;
import com.mirattic.sync.user.Visibility;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.data.domain.Limit;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Private rooms among friends. Only the host changes playback (host-authoritative MVP).
 * Rooms you are not a member of answer 404, so room ids can't be probed.
 */
@Service
public class RoomService {

	public record MemberView(UserSummary user, RoomMember.Role role, boolean present) {
	}

	/** `expiresInMs`: an invitation's time left (in invitation lists and `room:invite`), else absent. */
	/**
	 * `type`: the room's type (decision 93), null without one; `typeVersion` rises with each change, `typeSeen` is the
	 * viewer's seen one — a member (not the host) is asked about the change while it is lower.
	 */
	/** `memberLimit`: how many members the room takes, the host included (decision 106). */
	public record RoomView(String id, RoomContent content, List<MemberView> members, long createdAt, String code,
			Long expiresInMs, MediaProvider type, long typeVersion, long typeSeen, int memberLimit) {
		RoomView expiring(long ms) {
			return new RoomView(id, content, members, createdAt, code, ms, type, typeVersion, typeSeen, memberLimit);
		}
	}

	/** A member removed from a room because of a block, and who to tell (before the removal). */
	public record Separation(String roomId, String removedUserId, List<String> memberIds) {
	}

	/** Who to notify after a leave, and whether the room was closed (host left). */
	/** `memberIds`: everyone to tell (members, and invitees if it closed). `ended`: a closed room's members and title. */
	public record Left(List<String> memberIds, boolean closed, Ended ended) {
	}

	/** A room left by a deleted account. */
	public record Departure(String roomId, Left left) {
	}

	public enum Command {
		PLAY, PAUSE, SEEK
	}

	/** Members a room takes, the host included (decision 106). */
	static final int MAX_MEMBERS = 8;
	/** The 409 detail of a full room (joining, accepting, or asking a friend in one to let you in). */
	static final String ROOM_FULL = "room full";
	/** An invitation counts this long (decision 87); inviting again starts it over. */
	static final long INVITATION_MS = 30_000;
	static final int MAX_CHAT_LENGTH = 1000;
	/** The 409 detail of a watch request to a friend I'm already in a room with (the client says so). */
	static final String ALREADY_TOGETHER = "already in the same room";
	/** The 409 detail of an unconfirmed back by the host (the client asks them, then sends it confirmed). */
	static final String HOST_MUST_CONFIRM = "the host closes the room: confirm first";
	static final int CHAT_HISTORY = 100;
	private static final Pattern YOUTUBE_VIDEO_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
	private static final Pattern NETFLIX_ID = Pattern.compile("\\d{1,12}");
	/** Laftel "item/episode", the two ids in its player URL. */
	private static final Pattern LAFTEL_ID = Pattern.compile("\\d{1,10}/\\d{1,10}");
	/** Host capture times older than this (or in the future) are replaced by the receive time. */
	static final long MAX_CAPTURE_AGE_MS = 5_000;

	private final RoomRepository rooms;
	private final RoomMemberRepository members;
	private final FriendshipRepository friendships;
	private final UserRepository users;
	private final ChatMessageRepository messages;
	private final SocketHub hub;
	private final BlockRepository blocks;


	RoomService(RoomRepository rooms, RoomMemberRepository members, FriendshipRepository friendships,
			UserRepository users, ChatMessageRepository messages, SocketHub hub, BlockRepository blocks) {
		this.blocks = blocks;
		this.rooms = rooms;
		this.members = members;
		this.friendships = friendships;
		this.users = users;
		this.messages = messages;
		this.hub = hub;
	}

	/**
	 * A room hosted by me. Invitees get an invitation (decision 85); those in `joinIds` (a watch request of theirs
	 * this answers) become members at once.
	 */
	@Transactional
	/** `content` null: a room without a video yet (decision 92). */
	public RoomView create(String me, RoomContent content, Collection<String> inviteIds, Collection<String> joinIds) {
		if (content != null) {
			requireKnownId(content);
		}
		Room fresh = new Room(content, me);
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.remove(me);
		if (invitees.size() > memberLimit(fresh) - 1) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		// ponytail: check-then-insert; two creations drawing the same code at once still hit the unique index (1 in 31^8)
		while (rooms.findByCode(fresh.getCode()).isPresent()) {
			fresh.newCode();
		}
		Room room = rooms.save(fresh);
		members.save(new RoomMember(room.getId(), me, RoomMember.Role.HOST));
		for (String id : invitees) {
			if (joinIds.contains(id)) {
				members.save(new RoomMember(room.getId(), id, RoomMember.Role.MEMBER));
			} else {
				room.invite(id, System.currentTimeMillis());
			}
		}
		return view(room, members.findByRoomId(room.getId()), me);
	}

	/** The room after an invite, and who was a member before it. */
	public record Invited(RoomView room, List<String> before) {
	}

	/**
	 * Host invites friends to an existing room: an invitation each (decision 85), or membership at once for those
	 * in `joinIds` (answering their watch request). Existing members are skipped.
	 */
	@Transactional
	public Invited invite(String me, String roomId, Collection<String> inviteIds, Collection<String> joinIds) {
		// The row lock serializes concurrent invites, so together they can't pass the member limit.
		Room room = lockAsHost(me, roomId);
		List<String> before = memberIds(roomId);
		Set<String> current = new HashSet<>(before);
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.removeAll(current);
		long joining = invitees.stream().filter(joinIds::contains).count();
		int limit = memberLimit(room);
		if (!invitees.isEmpty() && current.size() >= limit) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, ROOM_FULL); // nobody more: no invitation either
		}
		if (invitees.size() > limit - 1 || current.size() + joining > limit) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		for (String id : invitees) {
			room.unban(id); // the host asked them back
			if (joinIds.contains(id)) {
				members.save(new RoomMember(roomId, id, RoomMember.Role.MEMBER, room.typeVersion()));
				room.uninvite(id); // an earlier invitation to it is answered too
			} else {
				room.invite(id, System.currentTimeMillis());
			}
		}
		return new Invited(view(rooms.findById(roomId).orElseThrow(RoomService::notFound), members.findByRoomId(roomId),
				null), before);
	}

	/**
	 * Runs after the block is committed. Room creation and invites share-lock the friendship they rely on, so
	 * the block's delete of it waited for them: every room they made is visible here.
	 * After `blocker` blocks `blocked`, the two stop sharing rooms: whoever doesn't host the shared room leaves it
	 * (the blocked user from the blocker's rooms, the blocker from any other room).
	 */
	@Transactional
	public List<Separation> separate(String blocker, String blocked) {
		Set<String> theirs = members.findByUserId(blocked).stream().map(RoomMember::getRoomId)
				.collect(Collectors.toSet());
		List<Separation> result = new ArrayList<>();
		for (RoomMember mine : members.findByUserId(blocker)) {
			if (!theirs.contains(mine.getRoomId())) {
				continue;
			}
			String leaving = mine.getRole() == RoomMember.Role.HOST ? blocked : blocker;
			List<String> everyone = memberIds(mine.getRoomId());
			members.delete(requireMember(leaving, mine.getRoomId()));
			result.add(new Separation(mine.getRoomId(), leaving, everyone));
		}
		// Invitations into a room the other is in go too.
		for (String[] pair : new String[][] {{blocker, blocked}, {blocked, blocker}}) {
			for (Room room : rooms.findInviting(pair[1])) {
				if (memberIds(room.getId()).contains(pair[0])) {
					room.uninvite(pair[1]);
				}
			}
		}
		return result;
	}

	/** Checked with a share lock held to the end of the transaction, so a concurrent block waits (see separate). */
	private boolean areFriends(String me, Set<String> others) {
		return others.isEmpty() || friendships.lockFriendships(me, others).size() == others.size();
	}

	/** The rooms inviting me, newest invitation first (decision 85), still in time (decision 87), with the time left. */
	@Transactional(readOnly = true)
	public List<RoomView> invitations(String me) {
		long now = System.currentTimeMillis();
		// ponytail: expired rows stay until answered, re-invited or the room goes; a sweep if they ever pile up.
		return rooms.findInviting(me).stream()
				.filter(r -> now - r.invitedAt(me) < INVITATION_MS)
				.sorted(java.util.Comparator.comparingLong((Room r) -> r.invitedAt(me)).reversed())
				.map(r -> view(r, members.findByRoomId(r.getId()), null).expiring(INVITATION_MS - (now - r.invitedAt(me))))
				.toList();
	}

	/**
	 * Accepting an invitation: I become a member (the members before, to tell). 404 without one (or one older than
	 * `INVITATION_MS`), or when I and a member block each other; 409 when the room is full (the invitation stays).
	 */
	@Transactional
	public Invited accept(String me, String roomId) {
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		// Kicked since (after coming in by the code): only a new invite from the host lets them back (it unbans).
		Long invitedAt = room.invitedAt(me);
		if (!room.uninvite(me) || System.currentTimeMillis() - invitedAt >= INVITATION_MS || room.isBanned(me)) {
			throw notFound();
		}
		List<String> before = memberIds(roomId);
		if (!before.contains(me)) {
			// Share-locking, as in joinByCode: a block committed first is seen, one made meanwhile waits for this.
			if (!before.isEmpty() && !blocks.lockBetween(me, before).isEmpty()) {
				throw notFound();
			}
			if (before.size() >= memberLimit(room)) {
				throw new ResponseStatusException(HttpStatus.CONFLICT, ROOM_FULL); // rolled back: still invited
			}
			members.save(new RoomMember(roomId, me, RoomMember.Role.MEMBER, room.typeVersion()));
		}
		return new Invited(view(room, members.findByRoomId(roomId), me), before);
	}

	/** Declining (or dropping) an invitation. Nothing to decline is fine. */
	@Transactional
	public void decline(String me, String roomId) {
		rooms.findForUpdate(roomId).ifPresent(room -> room.uninvite(me));
	}

	/** A watch request goes only to a friend. @return the requester, as the friend will see them. */
	@Transactional(readOnly = true)
	public UserSummary requestWatch(String me, String friendId) {
		if (!friendships.friendIds(me).contains(friendId)) {
			throw notFound();
		}
		return UserSummary.of(users.findById(me).orElseThrow(RoomService::notFound));
	}

	/**
	 * A new watch request (not its cancel): refused while I'm a member of a room the friend is in right now, where
	 * their answer would only invite me again.
	 */
	/**
	 * How many members the room takes, the host included (decision 106). ponytail: the same for every room; a premium
	 * host's larger limit goes here (reading the host's plan) when there is one.
	 */
	int memberLimit(Room room) {
		return MAX_MEMBERS;
	}

	/**
	 * A new watch request: refused (409, ROOM_FULL) when the room the friend's answer would invite me into is full. Their
	 * app picks it like `roomToInvite` (packages/types): a room they host showing what they watch now (or without a video
	 * yet), any room they host when they watch nothing; none → a new room, which has space. Refused only if every such
	 * room is full (which one comes first is the app's). `provider` / `contentId`: what they watch (their presence), or null.
	 * A prediction: the presence can be a moment behind the friend's app (a video changed just now), so the limit itself
	 * is held when they answer (invite / accept refuse a full room); this only spares asking where that would fail.
	 */
	@Transactional(readOnly = true)
	public void requireRoomFor(String me, String friendId, MediaProvider provider, String contentId) {
		// What they watch decides it: a friend hiding it (presence visibility not FRIENDS) isn't judged — the answer holds
		// the limit — so the answer to a request never tells what they hide.
		if (users.findById(friendId).map(u -> u.getPresenceVisibility() != Visibility.FRIENDS).orElse(true)) {
			return;
		}
		List<Room> answering = members.findByUserId(friendId).stream()
				.filter(m -> m.getRole() == RoomMember.Role.HOST)
				.map(m -> rooms.findById(m.getRoomId()).orElse(null))
				.filter(r -> r != null && (provider == null || r.content() == null
						|| r.content().provider() == provider && r.content().contentId().equals(contentId)))
				.toList();
		// A room I'm already in takes me without anyone more (the answer only tells me).
		if (!answering.isEmpty() && answering.stream().allMatch(r -> {
			List<String> in = memberIds(r.getId());
			return !in.contains(me) && in.size() >= memberLimit(r);
		})) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, ROOM_FULL);
		}
	}

	@Transactional(readOnly = true)
	public void requireApart(String me, String friendId) {
		Set<String> mine = members.findByUserId(me).stream().map(RoomMember::getRoomId).collect(Collectors.toSet());
		if (members.findByUserId(friendId).stream()
				.anyMatch(m -> mine.contains(m.getRoomId()) && hub.presentIn(m.getRoomId()).contains(friendId))) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, ALREADY_TOGETHER);
		}
	}

	/** Of these requesters, the ones still my friends (unfriended or blocked since: dropped). */
	@Transactional(readOnly = true)
	public List<UserSummary> friendsAmong(String me, List<String> ids) {
		Set<String> friends = Set.copyOf(friendships.friendIds(me));
		return users.findAllById(ids.stream().filter(friends::contains).toList()).stream().map(UserSummary::of).toList();
	}

	@Transactional(readOnly = true)
	public List<RoomView> mine(String me) {
		List<String> ids = members.findByUserId(me).stream().map(RoomMember::getRoomId).toList();
		return rooms.findAllById(ids).stream()
				.map(r -> view(r, members.findByRoomId(r.getId()), me))
				.toList();
	}

	@Transactional(readOnly = true)
	public RoomView get(String me, String roomId) {
		requireMember(me, roomId);
		return view(rooms.findById(roomId).orElseThrow(RoomService::notFound), members.findByRoomId(roomId), me);
	}

	/** Leaving as host closes the room for everyone. */
	@Transactional
	public Left leave(String me, String roomId) {
		return leave(me, roomId, false);
	}

	/**
	 * `asMember`: leaving as a member only (decision 93: a member's answer to a type change) — if the caller hosts the
	 * room by now (handed over meanwhile), 409 and nothing changes, instead of closing it for everyone.
	 */
	@Transactional
	public Left leave(String me, String roomId, boolean asMember) {
		// Roles read under the room lock: a hand-over in progress decides first whether this closes the room.
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		RoomMember self = requireMember(me, roomId);
		List<String> everyone = memberIds(roomId);
		if (self.getRole() == RoomMember.Role.HOST && asMember) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, "the host now");
		}
		if (self.getRole() == RoomMember.Role.HOST) {
			rooms.deleteById(roomId);
			return new Left(withInvited(everyone, room), true, new Ended(everyone, titleOf(room)));
		}
		members.delete(self);
		return new Left(everyone, false, null);
	}

	/** The room's host, or null (no room). */
	@Transactional(readOnly = true)
	public String hostOf(String roomId) {
		return members.findByRoomId(roomId).stream().filter(m -> m.getRole() == RoomMember.Role.HOST)
				.map(RoomMember::getUserId).findFirst().orElse(null);
	}

	@Transactional(readOnly = true)
	public boolean isHost(String me, String roomId) {
		return members.findByRoomIdAndUserId(roomId, me).filter(m -> m.getRole() == RoomMember.Role.HOST).isPresent();
	}

	/**
	 * The host's connections stayed out of the room (decision 90): closes it if they're still its host (not after a
	 * hand-over). @return the members and invitees to tell, or null if it stays.
	 */
	@Transactional
	public Left closeHostedBy(String hostId, String roomId) {
		Room room = rooms.findForUpdate(roomId).orElse(null);
		if (room == null || !isHost(hostId, roomId)) {
			return null;
		}
		List<String> everyone = memberIds(roomId);
		rooms.deleteById(roomId);
		return new Left(withInvited(everyone, room), true, new Ended(everyone, titleOf(room)));
	}

	/** A room closed by its host's leaving: who was in it, and what it was called (for their notice; "" without a video). */
	public record Ended(List<String> members, String title) {
	}

	private static String titleOf(Room room) {
		RoomContent content = room.content();
		return content == null ? "" : content.title();
	}

	/**
	 * Back from the room screen to the list (decision 90): the host's closes the room, like their "방 나가기" — once
	 * they `confirmed` it (409 otherwise: a screen that still showed them as a member asks them first); a member's
	 * does nothing (they stay in it). Decided under the room lock, after any hand-over in progress.
	 * @return the closed room's people to tell, or null if it stays.
	 */
	@Transactional
	public Left back(String me, String roomId, boolean confirmed) {
		rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		if (requireMember(me, roomId).getRole() != RoomMember.Role.HOST) {
			return null;
		}
		if (!confirmed) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, HOST_MUST_CONFIRM);
		}
		return leave(me, roomId);
	}

	/** Account deletion: leaves every room (closing those hosted), in the caller's transaction. */
	@Transactional
	public List<Departure> leaveAll(String me) {
		return members.findByUserId(me).stream().map(m -> new Departure(m.getRoomId(), leave(me, m.getRoomId())))
				.toList();
	}

	/** For `room:join`: checks membership and returns the state to start from. */
	@Transactional(readOnly = true)
	public PlaybackState join(String me, String roomId) {
		requireMember(me, roomId);
		return rooms.findById(roomId).orElseThrow(RoomService::notFound).playback();
	}

	/**
	 * The host's last connection left the room (window or side panel closed, left the room screen): the members
	 * stop where the host was instead of playing on alone. null if nothing changed (not the host, or paused).
	 */
	@Transactional
	public PlaybackState hostLeft(String me, String roomId, BooleanSupplier stillThere) {
		Room room = rooms.findForUpdate(roomId).orElse(null);
		boolean host = room != null && members.findByRoomIdAndUserId(roomId, me)
				.filter(m -> m.getRole() == RoomMember.Role.HOST).isPresent();
		// Asked again under the row lock: a host connection that joined meanwhile keeps the room going, and its
		// later commands wait for this lock, so they land after (and over) this pause.
		if (!host || !room.isPlaying() || stillThere.getAsBoolean()) {
			return null;
		}
		long now = System.currentTimeMillis();
		room.applyPlayback(me, room.positionAt(now), false, room.rate(), now);
		return room.playback();
	}

	/** A content change's new state and its "content" line. */
	/** `type`: the room's new type when the video's site changed it (decision 93), else null. */
	/** `state` null: the same video, only its line retitled. */
	public record Changed(PlaybackState state, ChatMessage.View log, MediaProvider type) {
	}

	/**
	 * The host picks the room's type (decision 93). @return the members to tell (`room:type`), or null if unchanged.
	 */
	@Transactional
	public List<String> setType(String me, String roomId, MediaProvider type) {
		Room room = lockAsHost(me, roomId);
		if (!room.setType(type)) {
			return null;
		}
		members.seeType(roomId, me, room.typeVersion()); // their own change: never asked about it (even after handing over)
		return memberIds(roomId);
	}

	@Transactional
	public PlaybackState playback(String me, String roomId, Command command, long positionMs, double rate, long capturedAt) {
		Room room = lockAsHost(me, roomId);
		long now = System.currentTimeMillis();
		long at = capturedAt > now || capturedAt < now - MAX_CAPTURE_AGE_MS ? now : capturedAt;
		boolean playing = switch (command) {
			case PLAY -> true;
			case PAUSE -> false;
			case SEEK -> room.isPlaying();
		};
		room.applyPlayback(me, positionMs, playing, rate, at);
		return room.playback();
	}

	/**
	 * "join" / "leave" line for a user who came into or went out of the room (decision 78), with their name as
	 * it was then. null if the room is gone.
	 */
	@Transactional
	public ChatMessage.View logPresence(String roomId, String userId, String kind) {
		Room room = rooms.findForUpdate(roomId).orElse(null);
		// Under the room lock a kick also holds: no join once kicked, and no leave after the kick's own line.
		if (room == null || "join".equals(kind) && !isMemberOf(userId, roomId) || "leave".equals(kind) && room.isBanned(userId)) {
			return null;
		}
		String name = nameOf(userId);
		return name == null ? null : messages.save(new ChatMessage(roomId, userId, name, null, kind)).view();
	}

	/** Members to tell, and the log line it made ("kick" / "host", text = that member's name). */
	public record Logged(List<String> memberIds, ChatMessage.View log) {
	}

	/**
	 * The host removes a member (decision 79). They can't come back by the room's code until the host invites them.
	 * 400 for the host itself, 404 if not a member.
	 */
	@Transactional
	public Logged kick(String me, String roomId, String userId) {
		Room room = lockAsHost(me, roomId);
		if (me.equals(userId)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cannot kick yourself");
		}
		RoomMember target = requireMember(userId, roomId);
		List<String> everyone = memberIds(roomId);
		members.delete(target);
		room.ban(userId);
		return new Logged(everyone, messages.save(new ChatMessage(roomId, userId, nameOf(userId), null, "kick")).view());
	}

	/** The host hands the room to another member (decision 79); the "host" line names the new host. */
	@Transactional
	public Logged handOver(String me, String roomId, String userId) {
		lockAsHost(me, roomId);
		if (me.equals(userId)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "already the host");
		}
		RoomMember next = requireMember(userId, roomId);
		requireMember(me, roomId).role(RoomMember.Role.MEMBER);
		next.role(RoomMember.Role.HOST);
		return new Logged(memberIds(roomId), messages.save(new ChatMessage(roomId, userId, nameOf(userId), null, "host")).view());
	}

	private boolean isMemberOf(String userId, String roomId) {
		return members.findByRoomIdAndUserId(roomId, userId).isPresent();
	}

	private String nameOf(String userId) {
		return users.findById(userId).map(User::getDisplayName).orElse(null);
	}

	/**
	 * Any member may chat; the text is stored trimmed.
	 * `contentKey`: the video the sender's position is on. Only one that is the room's video now has it stored with
	 * the position (a message sent as the host moved on keeps its time, just not as the new video's).
	 */
	@Transactional
	public ChatMessage.View chat(String me, String roomId, String text, Long mediaPositionMs, String contentKey) {
		// Under the room lock, like a kick: a member kicked meanwhile can't post after it.
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		requireMember(me, roomId);
		String trimmed = text == null ? "" : text.strip();
		if (trimmed.isEmpty() || trimmed.length() > MAX_CHAT_LENGTH || (mediaPositionMs != null && mediaPositionMs < 0)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid chat message");
		}
		boolean same = contentKey != null && contentKey.equals(room.contentKey());
		return messages.save(new ChatMessage(roomId, me, trimmed, mediaPositionMs, null, same ? room : null)).view();
	}

	/**
	 * A member's timestamp on the room's video ("stamp" line, text = their name): 400 without a video, on another
	 * video than the room's now (`contentKey`, the one the member stamped), or with a position before 0 or past its end.
	 */
	@Transactional
	public ChatMessage.View stamp(String me, String roomId, long positionMs, String contentKey) {
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		requireMember(me, roomId);
		RoomContent content = room.content();
		if (content == null || !room.contentKey().equals(contentKey) || positionMs < 0 || (content.durationMs() != null && positionMs > content.durationMs())) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid stamp");
		}
		return messages.save(new ChatMessage(roomId, me, nameOf(me), positionMs, "stamp", room)).view();
	}

	/** The author, or the room's host (moderation), deletes a message for everyone. */
	@Transactional
	public void deleteMessage(String me, String roomId, String messageId) {
		RoomMember self = requireMember(me, roomId);
		ChatMessage message = messages.findByIdAndRoomId(messageId, roomId).filter(m -> !m.isDeleted() && !m.isLog())
				.orElseThrow(RoomService::notFound);
		if (!message.view().userId().equals(me) && self.getRole() != RoomMember.Role.HOST) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "author or host only");
		}
		message.delete();
	}

	/** 404 unless a member (for socket events that only need membership). */
	@Transactional(readOnly = true)
	public void requireMembership(String me, String roomId) {
		requireMember(me, roomId);
	}

	@Transactional(readOnly = true)
	public List<String> allIds() {
		return rooms.findAll().stream().map(Room::getId).toList();
	}

	/** Every room's host: room → user. */
	@Transactional(readOnly = true)
	public Map<String, String> hosts() {
		return members.findAll().stream().filter(m -> m.getRole() == RoomMember.Role.HOST)
				.collect(Collectors.toMap(RoomMember::getRoomId, RoomMember::getUserId, (a, b) -> a));
	}


	/** A closing room's members and invitees: all told (`room:update`), so an invitation's banner goes too. */
	private static List<String> withInvited(List<String> memberIds, Room room) {
		List<String> all = new ArrayList<>(memberIds);
		room.invitedIds().stream().filter(id -> !all.contains(id)).forEach(all::add);
		return all;
	}

	/**
	 * Joining by a room's code (decision 77): anyone who knows it, up to the member limit. 404 for an unknown code
	 * and also when I and a member block each other (a shared room would undo the block, and this doesn't say so).
	 * Already a member: just the room.
	 */
	@Transactional
	public Invited joinByCode(String me, String input) {
		String code = input == null ? null : FriendCode.normalize(input);
		Room found = code == null ? null : rooms.findByCodeForUpdate(code).orElse(null);
		if (found == null) {
			throw notFound();
		}
		List<String> before = memberIds(found.getId());
		if (!before.contains(me)) {
			// A share-locking read: a block committed first is seen, and a block made meanwhile waits for this join
			// to commit, so the separation after it sees the new member.
			if (found.isBanned(me) || !before.isEmpty() && !blocks.lockBetween(me, before).isEmpty()) {
				throw notFound();
			}
			if (before.size() >= memberLimit(found)) {
				throw new ResponseStatusException(HttpStatus.CONFLICT, ROOM_FULL);
			}
			members.save(new RoomMember(found.getId(), me, RoomMember.Role.MEMBER, found.typeVersion()));
			found.uninvite(me); // in by the code: an invitation to it is answered
		}
		return new Invited(view(found, members.findByRoomId(found.getId()), me), before);
	}

	/** For a member's `pause:request`: the host to ask. 404 if not a member, 400 for the host itself. */
	@Transactional(readOnly = true)
	public String hostToAsk(String me, String roomId) {
		if (requireMember(me, roomId).getRole() == RoomMember.Role.HOST) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "the host pauses directly");
		}
		return members.findByRoomId(roomId).stream().filter(m -> m.getRole() == RoomMember.Role.HOST)
				.map(RoomMember::getUserId).findFirst().orElseThrow(RoomService::notFound);
	}

	/** A message to report: someone else's, in a room I'm in (404 otherwise, like any room lookup). */
	@Transactional(readOnly = true)
	public ChatMessage.View reportable(String me, String messageId) {
		ChatMessage.View m = messages.findById(messageId).filter(x -> !x.isDeleted() && !x.isLog()).map(ChatMessage::view)
				.orElseThrow(RoomService::notFound);
		requireMember(me, m.roomId());
		if (m.userId().equals(me)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cannot report yourself");
		}
		return m;
	}

	@Transactional(readOnly = true)
	public boolean shareARoom(String a, String b) {
		Set<String> theirs = members.findByUserId(b).stream().map(RoomMember::getRoomId).collect(Collectors.toSet());
		return members.findByUserId(a).stream().anyMatch(m -> theirs.contains(m.getRoomId()));
	}

	/** A page of messages, oldest first: the latest, or those before message `before` (of this room). */
	@Transactional(readOnly = true)
	public List<ChatMessage.View> history(String me, String roomId, String before) {
		requireMember(me, roomId);
		List<ChatMessage> page;
		if (before == null) {
			page = messages.findByRoomIdOrderByCreatedAtDescIdDesc(roomId, Limit.of(CHAT_HISTORY));
		} else {
			ChatMessage.View cursor = messages.findById(before).map(ChatMessage::view)
					.filter(m -> m.roomId().equals(roomId)).orElseThrow(RoomService::notFound);
			page = messages.findBefore(roomId, cursor.createdAt(), cursor.id(), Limit.of(CHAT_HISTORY));
		}
		List<ChatMessage.View> views = new ArrayList<>(page.stream().map(ChatMessage::view).toList());
		Collections.reverse(views);
		return views;
	}

	/**
	 * The host moved on to another content (e.g. the next video): the room restarts paused at 0 on it.
	 * @return the new playback state and its "content" log line; for the same video with a new title, no state and
	 *         its "content" line retitled; null if nothing to tell
	 */
	@Transactional
	public Changed changeContent(String me, String roomId, RoomContent content) {
		requireKnownId(content);
		Room room = lockAsHost(me, roomId);
		RoomContent before = room.content();
		if (!room.changeContent(me, content, System.currentTimeMillis())) {
			// The title or channel read late (YouTube's tab says "YouTube" until the page catches up): the line follows,
			// if it is still this video's — the room's last "content" line, naming this video (or, written before lines
			// named theirs, saying the title it had).
			String was = before == null ? null : before.title();
			String key = room.contentKey();
			return messages.findFirstByRoomIdAndKindOrderBySeqDesc(roomId, "content")
					.filter(m -> !m.view().deleted() && !content.label().equals(m.view().text()))
					.filter(m -> m.view().contentKey() != null ? m.view().contentKey().equals(key) : m.view().text().equals(was))
					.map(m -> new Changed(null, m.retitle(content.label()).view(), null))
					.orElse(null);
		}
		MediaProvider type = room.setType(content.provider()) ? content.provider() : null; // a video of another site
		if (type != null) {
			members.seeType(roomId, me, room.typeVersion()); // the host's own change (see setType)
		}
		return new Changed(room.playback(), messages.save(new ChatMessage(roomId, me, content.label(), null, "content").about(room)).view(), type);
	}

	/**
	 * Locks the room row, then checks membership (404) and the host role (403). The lock comes first: under
	 * REPEATABLE READ the first plain read fixes the snapshot, so reading members before the lock would let
	 * a transaction that waited on it see members as they were before the one it waited for.
	 */
	private Room lockAsHost(String me, String roomId) {
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		if (requireMember(me, roomId).getRole() != RoomMember.Role.HOST) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "host only");
		}
		return room;
	}

	/**
	 * Clients build the watch URL from provider + contentId (never from another user's URL), so the id
	 * must be one they can build it from.
	 */
	private static void requireKnownId(RoomContent content) {
		if (content.provider() == MediaProvider.youtube && !YOUTUBE_VIDEO_ID.matcher(content.contentId()).matches()) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid youtube video id");
		}
		if (content.provider() == MediaProvider.netflix && !NETFLIX_ID.matcher(content.contentId()).matches()) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid netflix id");
		}
		if (content.provider() == MediaProvider.laftel && !LAFTEL_ID.matcher(content.contentId()).matches()) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid laftel id");
		}
	}

	@Transactional(readOnly = true)
	public List<String> memberIds(String roomId) {
		return members.findByRoomId(roomId).stream().map(RoomMember::getUserId).toList();
	}

	/** Tells every member's connections to refetch the room (same pattern as `friend:update`). */
	/**
	 * The host's leaving closed the room (decision 90): `room:closed` with its title to the other members (for their
	 * notice; not to invitees), then the usual `room:update` to everyone told.
	 */
	public void announceClosed(String roomId, String hostId, Left left) {
		long now = System.currentTimeMillis();
		ServerEvent closed = new ServerEvent("room:closed", roomId, hostId, null, now, Map.of("title", left.ended().title()));
		// Kept until each member's app acknowledges it (`room:closed:ack`), sent again on their connections meanwhile:
		// one offline or reconnecting right now still gets it.
		left.ended().members().stream().filter(id -> !id.equals(hostId)).forEach(id -> hub.sendKept(id, closed));
		announce(roomId, left.memberIds());
	}

	/**
	 * The room's type changed (decision 93): its members but the host are told to look again (`room:type`, a hint —
	 * what they are asked comes from their room view: `typeVersion` above their `typeSeen`, so nothing is lost while
	 * offline and nothing stays once they're out of the room).
	 */
	public void announceType(String roomId) {
		ServerEvent event = new ServerEvent("room:type", roomId, null, null, System.currentTimeMillis(), null);
		members.findByRoomId(roomId).stream()
				.filter(m -> m.getRole() != RoomMember.Role.HOST)
				.forEach(m -> hub.sendEvent(m.getUserId(), event));
	}

	/** The member confirmed the room's type change up to `version` (decision 93): not asked about it again. */
	@Transactional
	public void seeType(String me, String roomId, long version) {
		Room room = rooms.findById(roomId).orElseThrow(RoomService::notFound);
		requireMember(me, roomId);
		members.seeType(roomId, me, Math.min(version, room.typeVersion()));
	}

	public void announce(String roomId, Collection<String> memberIds) {
		ServerEvent event = new ServerEvent("room:update", roomId, null, null, System.currentTimeMillis(), null);
		for (String id : memberIds) {
			hub.sendEvent(id, event);
		}
	}

	private RoomMember requireMember(String me, String roomId) {
		return members.findByRoomIdAndUserId(roomId, me).orElseThrow(RoomService::notFound);
	}

	/** `viewer` gets their own `typeSeen`; null = a view for someone else. */
	private RoomView view(Room room, List<RoomMember> list, String viewer) {
		Map<String, User> byId = users.findAllById(list.stream().map(RoomMember::getUserId).toList()).stream()
				.collect(Collectors.toMap(User::getId, Function.identity()));
		Set<String> present = hub.presentIn(room.getId());
		List<MemberView> views = list.stream()
				.filter(m -> byId.containsKey(m.getUserId()))
				.map(m -> new MemberView(UserSummary.of(byId.get(m.getUserId())), m.getRole(),
						present.contains(m.getUserId())))
				.toList();
		RoomMember self = list.stream().filter(m -> m.getUserId().equals(viewer)).findFirst().orElse(null);
		return new RoomView(room.getId(), room.content(), views, room.getCreatedAt(), room.getCode(), null, room.type(),
				room.typeVersion(), self == null ? room.typeVersion() : self.getTypeSeenVersion(), memberLimit(room));
	}

	private static ResponseStatusException notFound() {
		return new ResponseStatusException(HttpStatus.NOT_FOUND);
	}
}
