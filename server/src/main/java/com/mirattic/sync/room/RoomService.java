package com.mirattic.sync.room;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.FriendCode;
import com.mirattic.sync.friend.BlockRepository;
import com.mirattic.sync.user.UserSummary;
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

	/** `unread` and `muted` are the viewer's own (0 / false in a view sent to someone else). */
	/** `expiresInMs`: an invitation's time left (in invitation lists and `room:invite`), else absent. */
	public record RoomView(String id, RoomContent content, List<MemberView> members, long createdAt, long unread,
			boolean muted, String code, Long expiresInMs) {
		RoomView expiring(long ms) {
			return new RoomView(id, content, members, createdAt, unread, muted, code, ms);
		}
	}

	/** A member removed from a room because of a block, and who to tell (before the removal). */
	public record Separation(String roomId, String removedUserId, List<String> memberIds) {
	}

	/** Who to notify after a leave, and whether the room was closed (host left). */
	public record Left(List<String> memberIds, boolean closed) {
	}

	/** A room left by a deleted account. */
	public record Departure(String roomId, Left left) {
	}

	public enum Command {
		PLAY, PAUSE, SEEK
	}

	static final int MAX_INVITES = 7;
	/** An invitation counts this long (decision 87); inviting again starts it over. */
	static final long INVITATION_MS = 30_000;
	static final int MAX_CHAT_LENGTH = 1000;
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
	public RoomView create(String me, RoomContent content, Collection<String> inviteIds, Collection<String> joinIds) {
		requireKnownId(content);
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.remove(me);
		if (invitees.size() > MAX_INVITES) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		Room fresh = new Room(content, me);
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
		if (invitees.size() > MAX_INVITES || current.size() - 1 + joining > MAX_INVITES) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		for (String id : invitees) {
			room.unban(id); // the host asked them back
			if (joinIds.contains(id)) {
				members.save(new RoomMember(roomId, id, RoomMember.Role.MEMBER));
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
			if (before.size() > MAX_INVITES) {
				throw new ResponseStatusException(HttpStatus.CONFLICT, "room full"); // rolled back: still invited
			}
			members.save(new RoomMember(roomId, me, RoomMember.Role.MEMBER));
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
		// Roles read under the room lock: a hand-over in progress decides first whether this closes the room.
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		RoomMember self = requireMember(me, roomId);
		List<String> everyone = memberIds(roomId);
		if (self.getRole() == RoomMember.Role.HOST) {
			rooms.deleteById(roomId);
			return new Left(withInvited(everyone, room), true);
		}
		members.delete(self);
		return new Left(everyone, false);
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
	 * Joining or leaving the room live (`room:join`, `room:leave`, disconnect): what arrived until now has been
	 * seen. Marked on the server, before the change is announced, so a list refetched after it is already current.
	 */
	@Transactional
	public void read(String me, String roomId) {
		// The room lock orders this against chat() inserts; taken first, before any read fixes the snapshot.
		if (rooms.findForUpdate(roomId).isEmpty()) {
			return;
		}
		members.findByRoomIdAndUserId(roomId, me).ifPresent(m -> m.read(messages.lastSeq(roomId)));
	}

	@Transactional
	public void mute(String me, String roomId, boolean muted) {
		requireMember(me, roomId).mute(muted);
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
		room.applyPlayback(me, room.positionAt(now), false, now);
		return room.playback();
	}

	/**
	 * A playback command's new state, with what the chat log (RoomLog) needs: whether it was playing before, where
	 * it would have been without the command (`expected`) and where it is now (`landed`, clamped to the duration).
	 */
	public record Applied(PlaybackState state, Command command, boolean wasPlaying, long expected, long landed) {
	}

	/** A content change's new state and its "content" line. */
	public record Changed(PlaybackState state, ChatMessage.View log) {
	}

	@Transactional
	public Applied playback(String me, String roomId, Command command, long positionMs, long capturedAt) {
		Room room = lockAsHost(me, roomId);
		boolean wasPlaying = room.isPlaying();
		long now = System.currentTimeMillis();
		long at = capturedAt > now || capturedAt < now - MAX_CAPTURE_AGE_MS ? now : capturedAt;
		long expected = room.positionAt(at);
		boolean playing = switch (command) {
			case PLAY -> true;
			case PAUSE -> false;
			case SEEK -> room.isPlaying();
		};
		room.applyPlayback(me, positionMs, playing, at);
		return new Applied(room.playback(), command, wasPlaying, expected, room.positionAt(at));
	}

	/** A room log line (decision 78); null if the room is gone. */
	@Transactional
	public ChatMessage.View log(String roomId, String userId, String kind, String text, Long positionMs) {
		// Under the room lock, like chat: read marks see every line inserted before them.
		if (rooms.findForUpdate(roomId).isEmpty()) {
			return null;
		}
		return messages.save(new ChatMessage(roomId, userId, text, positionMs, kind)).view();
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

	/** Any member may chat; the text is stored trimmed. */
	@Transactional
	public ChatMessage.View chat(String me, String roomId, String text, Long mediaPositionMs) {
		// Under the room lock, so a read mark (read(), join()) sees every message inserted before it and none after.
		rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
		requireMember(me, roomId);
		String trimmed = text == null ? "" : text.strip();
		if (trimmed.isEmpty() || trimmed.length() > MAX_CHAT_LENGTH || (mediaPositionMs != null && mediaPositionMs < 0)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid chat message");
		}
		return messages.save(new ChatMessage(roomId, me, trimmed, mediaPositionMs, null)).view();
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

	/** Closes a room nobody is in (decision 75). @return its members (to tell them), empty if already gone. */
	@Transactional
	public List<String> close(String roomId) {
		Room room = rooms.findForUpdate(roomId).orElse(null);
		if (room == null) {
			return List.of();
		}
		List<String> everyone = memberIds(roomId);
		rooms.deleteById(roomId);
		return withInvited(everyone, room);
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
			if (before.size() > MAX_INVITES) {
				throw new ResponseStatusException(HttpStatus.CONFLICT, "room full");
			}
			members.save(new RoomMember(found.getId(), me, RoomMember.Role.MEMBER));
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
	 * @return the new playback state and its "content" log line, or null if it is the same video with new metadata
	 */
	@Transactional
	public Changed changeContent(String me, String roomId, RoomContent content) {
		requireKnownId(content);
		Room room = lockAsHost(me, roomId);
		if (!room.changeContent(me, content, System.currentTimeMillis())) {
			return null;
		}
		return new Changed(room.playback(), messages.save(new ChatMessage(roomId, me, content.title(), null, "content")).view());
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
	public void announce(String roomId, Collection<String> memberIds) {
		ServerEvent event = new ServerEvent("room:update", roomId, null, null, System.currentTimeMillis(), null);
		for (String id : memberIds) {
			hub.sendEvent(id, event);
		}
	}

	private RoomMember requireMember(String me, String roomId) {
		return members.findByRoomIdAndUserId(roomId, me).orElseThrow(RoomService::notFound);
	}

	/** `viewer` gets their unread count and mute; null = a view for someone else. */
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
		long unread = self == null ? 0
				: messages.countByRoomIdAndUserIdNotAndKindIsNullAndDeletedFalseAndSeqGreaterThan(room.getId(), viewer,
						self.getLastReadSeq());
		return new RoomView(room.getId(), room.content(), views, room.getCreatedAt(), unread,
				self != null && self.isMuted(), room.getCode(), null);
	}

	private static ResponseStatusException notFound() {
		return new ResponseStatusException(HttpStatus.NOT_FOUND);
	}
}
