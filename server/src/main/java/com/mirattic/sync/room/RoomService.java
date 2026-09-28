package com.mirattic.sync.room;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.presence.MediaProvider;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
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

	public record RoomView(String id, RoomContent content, List<MemberView> members, long createdAt) {
	}

	/** A member removed from a room because of a block, and who to tell (before the removal). */
	public record Separation(String roomId, String removedUserId, List<String> memberIds) {
	}

	/** Who to notify after a leave, and whether the room was closed (host left). */
	public record Left(List<String> memberIds, boolean closed) {
	}

	public enum Command {
		PLAY, PAUSE, SEEK
	}

	static final int MAX_INVITES = 7;
	static final int MAX_CHAT_LENGTH = 1000;
	static final int CHAT_HISTORY = 100;
	private static final Pattern YOUTUBE_VIDEO_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
	private static final Pattern NETFLIX_ID = Pattern.compile("\\d{1,12}");
	/** Host capture times older than this (or in the future) are replaced by the receive time. */
	static final long MAX_CAPTURE_AGE_MS = 5_000;

	private final RoomRepository rooms;
	private final RoomMemberRepository members;
	private final FriendshipRepository friendships;
	private final UserRepository users;
	private final ChatMessageRepository messages;
	private final SocketHub hub;

	RoomService(RoomRepository rooms, RoomMemberRepository members, FriendshipRepository friendships,
			UserRepository users, ChatMessageRepository messages, SocketHub hub) {
		this.rooms = rooms;
		this.members = members;
		this.friendships = friendships;
		this.users = users;
		this.messages = messages;
		this.hub = hub;
	}

	@Transactional
	public RoomView create(String me, RoomContent content, Collection<String> inviteIds) {
		requireKnownId(content);
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.remove(me);
		if (invitees.size() > MAX_INVITES) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		Room room = rooms.save(new Room(content, me));
		members.save(new RoomMember(room.getId(), me, RoomMember.Role.HOST));
		for (String id : invitees) {
			members.save(new RoomMember(room.getId(), id, RoomMember.Role.MEMBER));
		}
		return view(room, members.findByRoomId(room.getId()));
	}

	/** The room after an invite, and who was a member before it. */
	public record Invited(RoomView room, List<String> before) {
	}

	/** Host adds friends to an existing room. Existing members are skipped. */
	@Transactional
	public Invited invite(String me, String roomId, Collection<String> inviteIds) {
		// The row lock serializes concurrent invites, so together they can't pass the member limit.
		lockAsHost(me, roomId);
		List<String> before = memberIds(roomId);
		Set<String> current = new HashSet<>(before);
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.removeAll(current);
		if (current.size() - 1 + invitees.size() > MAX_INVITES) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!areFriends(me, invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		for (String id : invitees) {
			members.save(new RoomMember(roomId, id, RoomMember.Role.MEMBER));
		}
		return new Invited(view(rooms.findById(roomId).orElseThrow(RoomService::notFound), members.findByRoomId(roomId)),
				before);
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
		return result;
	}

	/** Checked with a share lock held to the end of the transaction, so a concurrent block waits (see separate). */
	private boolean areFriends(String me, Set<String> others) {
		return others.isEmpty() || friendships.lockFriendships(me, others).size() == others.size();
	}

	/** A watch request goes only to a friend. @return the requester, as the friend will see them. */
	@Transactional(readOnly = true)
	public UserSummary requestWatch(String me, String friendId) {
		if (!friendships.friendIds(me).contains(friendId)) {
			throw notFound();
		}
		return UserSummary.of(users.findById(me).orElseThrow(RoomService::notFound));
	}

	@Transactional(readOnly = true)
	public List<RoomView> mine(String me) {
		List<String> ids = members.findByUserId(me).stream().map(RoomMember::getRoomId).toList();
		return rooms.findAllById(ids).stream()
				.map(r -> view(r, members.findByRoomId(r.getId())))
				.toList();
	}

	@Transactional(readOnly = true)
	public RoomView get(String me, String roomId) {
		requireMember(me, roomId);
		return view(rooms.findById(roomId).orElseThrow(RoomService::notFound), members.findByRoomId(roomId));
	}

	/** Leaving as host closes the room for everyone. */
	@Transactional
	public Left leave(String me, String roomId) {
		RoomMember self = requireMember(me, roomId);
		List<String> everyone = memberIds(roomId);
		if (self.getRole() == RoomMember.Role.HOST) {
			rooms.deleteById(roomId);
			return new Left(everyone, true);
		}
		members.delete(self);
		return new Left(everyone, false);
	}

	/** For `room:join`: checks membership and returns the state to start from. */
	@Transactional(readOnly = true)
	public PlaybackState join(String me, String roomId) {
		requireMember(me, roomId);
		return rooms.findById(roomId).orElseThrow(RoomService::notFound).playback();
	}

	@Transactional
	public PlaybackState playback(String me, String roomId, Command command, long positionMs, long capturedAt) {
		Room room = lockAsHost(me, roomId);
		long now = System.currentTimeMillis();
		long at = capturedAt > now || capturedAt < now - MAX_CAPTURE_AGE_MS ? now : capturedAt;
		boolean playing = switch (command) {
			case PLAY -> true;
			case PAUSE -> false;
			case SEEK -> room.isPlaying();
		};
		room.applyPlayback(me, positionMs, playing, at);
		return room.playback();
	}

	/** Any member may chat; the text is stored trimmed. */
	@Transactional
	public ChatMessage.View chat(String me, String roomId, String text, Long mediaPositionMs) {
		requireMember(me, roomId);
		String trimmed = text == null ? "" : text.strip();
		if (trimmed.isEmpty() || trimmed.length() > MAX_CHAT_LENGTH || (mediaPositionMs != null && mediaPositionMs < 0)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid chat message");
		}
		return messages.save(new ChatMessage(roomId, me, trimmed, mediaPositionMs)).view();
	}

	/** The latest messages, oldest first. */
	@Transactional(readOnly = true)
	public List<ChatMessage.View> history(String me, String roomId) {
		requireMember(me, roomId);
		List<ChatMessage.View> latest = new ArrayList<>(messages
				.findByRoomIdOrderByCreatedAtDesc(roomId, Limit.of(CHAT_HISTORY)).stream().map(ChatMessage::view).toList());
		Collections.reverse(latest);
		return latest;
	}

	/** The host moved on to another content (e.g. the next video): the room restarts paused at 0 on it. */
	@Transactional
	public PlaybackState changeContent(String me, String roomId, RoomContent content) {
		requireKnownId(content);
		Room room = lockAsHost(me, roomId);
		room.changeContent(me, content, System.currentTimeMillis());
		return room.playback();
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

	private RoomView view(Room room, List<RoomMember> list) {
		Map<String, User> byId = users.findAllById(list.stream().map(RoomMember::getUserId).toList()).stream()
				.collect(Collectors.toMap(User::getId, Function.identity()));
		Set<String> present = hub.presentIn(room.getId());
		List<MemberView> views = list.stream()
				.filter(m -> byId.containsKey(m.getUserId()))
				.map(m -> new MemberView(UserSummary.of(byId.get(m.getUserId())), m.getRole(),
						present.contains(m.getUserId())))
				.toList();
		return new RoomView(room.getId(), room.content(), views, room.getCreatedAt());
	}

	private static ResponseStatusException notFound() {
		return new ResponseStatusException(HttpStatus.NOT_FOUND);
	}
}
