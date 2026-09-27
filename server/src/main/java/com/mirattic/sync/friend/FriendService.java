package com.mirattic.sync.friend;

import com.mirattic.sync.presence.PresenceService;
import com.mirattic.sync.presence.PresenceView;
import com.mirattic.sync.user.FriendCode;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import com.mirattic.sync.user.UserSummary;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class FriendService {

	public record FriendView(UserSummary user, PresenceView presence) {
	}

	public record FriendRequestView(String id, UserSummary user, long createdAt) {
	}

	public record FriendRequests(List<FriendRequestView> incoming, List<FriendRequestView> outgoing) {
	}

	private final FriendshipRepository friendships;
	private final BlockRepository blocks;
	private final UserRepository users;
	private final PresenceService presence;

	FriendService(FriendshipRepository friendships, BlockRepository blocks, UserRepository users,
			PresenceService presence) {
		this.friendships = friendships;
		this.blocks = blocks;
		this.users = users;
		this.presence = presence;
	}

	@Transactional(readOnly = true)
	public List<FriendView> friends(String me) {
		return users.findAllById(friendships.friendIds(me)).stream()
				.map(u -> new FriendView(UserSummary.of(u), presence.viewOf(u)))
				.toList();
	}

	@Transactional(readOnly = true)
	public FriendRequests requests(String me) {
		return new FriendRequests(
				views(friendships.findByAddresseeIdAndStatus(me, Friendship.Status.PENDING), Friendship::getRequesterId),
				views(friendships.findByRequesterIdAndStatus(me, Friendship.Status.PENDING), Friendship::getAddresseeId));
	}

	/**
	 * Sends a request to the owner of `friendCode`. A request to someone who already asked you accepts theirs.
	 * Unknown codes and blocked pairs both answer 404, so a code can't be used to detect a block.
	 */
	@Transactional
	public UserSummary sendRequest(String me, String friendCode) {
		String code = FriendCode.normalize(friendCode);
		User target = code == null ? null : users.findByFriendCode(code).orElse(null);
		if (target == null) {
			throw notFound();
		}
		String targetId = target.getId();
		if (me.equals(targetId)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cannot target yourself");
		}
		if (blocks.existsBetween(me, targetId)) {
			throw notFound();
		}
		Friendship existing = friendships.findPair(me, targetId).orElse(null);
		if (existing == null) {
			friendships.save(new Friendship(me, targetId));
		} else if (existing.getStatus() == Friendship.Status.PENDING && existing.getRequesterId().equals(targetId)) {
			existing.accept();
		} else {
			throw new ResponseStatusException(HttpStatus.CONFLICT, "request already exists");
		}
		return UserSummary.of(target);
	}

	@Transactional
	public String accept(String me, String requestId) {
		Friendship f = friendships.findById(requestId)
				.filter(x -> x.getStatus() == Friendship.Status.PENDING && x.getAddresseeId().equals(me))
				.orElseThrow(FriendService::notFound);
		f.accept();
		return f.getRequesterId();
	}

	/** Decline (addressee) or cancel (requester). */
	@Transactional
	public String deleteRequest(String me, String requestId) {
		Friendship f = friendships.findById(requestId)
				.filter(x -> x.getStatus() == Friendship.Status.PENDING
						&& (x.getAddresseeId().equals(me) || x.getRequesterId().equals(me)))
				.orElseThrow(FriendService::notFound);
		friendships.delete(f);
		return f.getRequesterId().equals(me) ? f.getAddresseeId() : f.getRequesterId();
	}

	@Transactional
	public void removeFriend(String me, String friendId) {
		Friendship f = friendships.findPair(me, friendId)
				.filter(x -> x.getStatus() == Friendship.Status.ACCEPTED)
				.orElseThrow(FriendService::notFound);
		friendships.delete(f);
	}

	@Transactional
	public void block(String me, String targetId) {
		requireOther(me, targetId);
		if (!blocks.existsById(new Block.Key(me, targetId))) {
			blocks.save(new Block(me, targetId));
		}
		// Blocking ends the friendship and any pending request, so presence stops flowing both ways.
		friendships.findPair(me, targetId).ifPresent(friendships::delete);
	}

	@Transactional
	public void unblock(String me, String targetId) {
		blocks.deleteById(new Block.Key(me, targetId));
	}

	@Transactional(readOnly = true)
	public List<UserSummary> blocked(String me) {
		List<String> ids = blocks.findByBlockerId(me).stream().map(Block::getBlockedId).toList();
		return users.findAllById(ids).stream().map(UserSummary::of).toList();
	}

	private List<FriendRequestView> views(List<Friendship> list, Function<Friendship, String> other) {
		Map<String, User> byId = users.findAllById(list.stream().map(other).toList()).stream()
				.collect(Collectors.toMap(User::getId, Function.identity()));
		return list.stream()
				.filter(f -> byId.containsKey(other.apply(f)))
				.map(f -> new FriendRequestView(f.getId(), UserSummary.of(byId.get(other.apply(f))), f.getCreatedAt()))
				.toList();
	}

	private void requireOther(String me, String targetId) {
		if (me.equals(targetId)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cannot target yourself");
		}
		if (!users.existsById(targetId)) {
			throw notFound();
		}
	}

	private static ResponseStatusException notFound() {
		return new ResponseStatusException(HttpStatus.NOT_FOUND);
	}
}
