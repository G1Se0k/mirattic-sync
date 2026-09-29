package com.mirattic.sync.account;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserRepository;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
class AccountService {

	/** What to announce after the commit: the rooms left, and everyone with a friendship or request. */
	record Deleted(List<RoomService.Departure> rooms, List<String> contacts) {
	}

	private final UserRepository users;
	private final FriendshipRepository friendships;
	private final RoomService rooms;

	AccountService(UserRepository users, FriendshipRepository friendships, RoomService rooms) {
		this.users = users;
		this.friendships = friendships;
		this.rooms = rooms;
	}

	/**
	 * Deletes the user's Sync profile and everything that is theirs: rows referencing the user go by ON DELETE
	 * CASCADE (friendships, blocks, memberships, chat messages, reports), rooms they host are closed. The Mirattic
	 * account itself stays (Auth owns it). The caller has checked a fresh Auth sign-in (AccountController).
	 */
	@Transactional
	public Deleted delete(String me) {
		// Locked first: a room or invite made for me meanwhile waits and then fails, instead of being left behind.
		User user = users.findForUpdate(me).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
		List<String> contacts = friendships.contactIds(me);
		List<RoomService.Departure> left = rooms.leaveAll(me);
		users.delete(user);
		return new Deleted(left, contacts);
	}
}
