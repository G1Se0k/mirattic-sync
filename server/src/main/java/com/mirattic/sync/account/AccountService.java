package com.mirattic.sync.account;

import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.user.IdentityProvider;
import com.mirattic.sync.user.User;
import com.mirattic.sync.user.UserIdentity;
import com.mirattic.sync.user.UserIdentityRepository;
import com.mirattic.sync.user.UserRepository;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
class AccountService {

	/** What to announce after the commit: the rooms left, and everyone with a friendship or request. */
	record Deleted(List<RoomService.Departure> rooms, List<String> contacts) {
	}

	private final UserRepository users;
	private final UserIdentityRepository identities;
	private final FriendshipRepository friendships;
	private final RoomService rooms;
	private final PasswordEncoder passwordEncoder;

	AccountService(UserRepository users, UserIdentityRepository identities, FriendshipRepository friendships,
			RoomService rooms, PasswordEncoder passwordEncoder) {
		this.users = users;
		this.identities = identities;
		this.friendships = friendships;
		this.rooms = rooms;
		this.passwordEncoder = passwordEncoder;
	}

	/**
	 * Deletes the user and everything that is theirs: rows referencing the user go by ON DELETE CASCADE
	 * (identities, refresh tokens, friendships, blocks, memberships, chat messages, reports), rooms they host
	 * are closed. The password is asked again, so a stolen access token alone can't delete the account.
	 */
	@Transactional
	public Deleted delete(String me, String password) {
		// Locked first: a room or invite made for me meanwhile waits and then fails, instead of being left behind.
		User user = users.findForUpdate(me).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
		// ponytail: email/password is the only identity type; an OAuth-only account needs a fresh-login check here.
		UserIdentity local = identities.findByUserId(me).stream()
				.filter(i -> i.getProvider() == IdentityProvider.LOCAL).findFirst()
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "no password to confirm"));
		// 403, not 401: a 401 would make clients refresh and retry.
		if (!passwordEncoder.matches(password, local.getPasswordHash())) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "wrong password");
		}
		List<String> contacts = friendships.contactIds(me);
		List<RoomService.Departure> left = rooms.leaveAll(me);
		users.delete(user);
		return new Deleted(left, contacts);
	}
}
