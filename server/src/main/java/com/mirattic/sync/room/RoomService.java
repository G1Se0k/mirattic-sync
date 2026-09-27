package com.mirattic.sync.room;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
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

	/** Who to notify after a leave, and whether the room was closed (host left). */
	public record Left(List<String> memberIds, boolean closed) {
	}

	public enum Command {
		PLAY, PAUSE, SEEK
	}

	static final int MAX_INVITES = 7;
	/** Host capture times older than this (or in the future) are replaced by the receive time. */
	static final long MAX_CAPTURE_AGE_MS = 5_000;

	private final RoomRepository rooms;
	private final RoomMemberRepository members;
	private final FriendshipRepository friendships;
	private final UserRepository users;
	private final SocketHub hub;

	RoomService(RoomRepository rooms, RoomMemberRepository members, FriendshipRepository friendships,
			UserRepository users, SocketHub hub) {
		this.rooms = rooms;
		this.members = members;
		this.friendships = friendships;
		this.users = users;
		this.hub = hub;
	}

	@Transactional
	public RoomView create(String me, RoomContent content, Collection<String> inviteIds) {
		Set<String> invitees = new HashSet<>(inviteIds);
		invitees.remove(me);
		if (invitees.size() > MAX_INVITES) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "too many invites");
		}
		if (!new HashSet<>(friendships.friendIds(me)).containsAll(invitees)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "can only invite friends");
		}
		Room room = rooms.save(new Room(content, me));
		members.save(new RoomMember(room.getId(), me, RoomMember.Role.HOST));
		for (String id : invitees) {
			members.save(new RoomMember(room.getId(), id, RoomMember.Role.MEMBER));
		}
		return view(room, members.findByRoomId(room.getId()));
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
		if (requireMember(me, roomId).getRole() != RoomMember.Role.HOST) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "only the host controls playback");
		}
		Room room = rooms.findForUpdate(roomId).orElseThrow(RoomService::notFound);
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
