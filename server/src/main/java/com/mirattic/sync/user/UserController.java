package com.mirattic.sync.user;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class UserController {

	/**
	 * `email` is the contact email of the user's first identity that has one; null for email-less OAuth users.
	 * `friendCode` is only ever shown to its owner, who shares it to be added as a friend.
	 */
	public record Me(String id, String email, List<IdentityProvider> providers, String displayName,
			String friendCode, Visibility presenceVisibility, Visibility positionVisibility) {
	}

	public record PrivacyRequest(@NotNull Visibility presenceVisibility, @NotNull Visibility positionVisibility) {
	}

	private final UserRepository users;
	private final UserIdentityRepository identities;

	UserController(UserRepository users, UserIdentityRepository identities) {
		this.users = users;
		this.identities = identities;
	}

	@GetMapping("/me")
	Me me(@AuthenticationPrincipal Jwt jwt) {
		return me(load(jwt.getSubject()));
	}

	@PutMapping("/me/privacy")
	@Transactional
	Me updatePrivacy(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody PrivacyRequest req) {
		User me = load(jwt.getSubject());
		me.setPrivacy(req.presenceVisibility(), req.positionVisibility());
		return me(me);
	}

	@PostMapping("/me/friend-code")
	@Transactional
	Me regenerateFriendCode(@AuthenticationPrincipal Jwt jwt) {
		User me = load(jwt.getSubject());
		me.regenerateFriendCode();
		return me(me);
	}

	private Me me(User u) {
		List<UserIdentity> list = identities.findByUserId(u.getId());
		String email = list.stream().map(UserIdentity::getEmail).filter(e -> e != null).findFirst().orElse(null);
		return new Me(u.getId(), email, list.stream().map(UserIdentity::getProvider).distinct().toList(),
				u.getDisplayName(), u.getFriendCode(), u.getPresenceVisibility(), u.getPositionVisibility());
	}

	private User load(String id) {
		return users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
	}
}
