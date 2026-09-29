package com.mirattic.sync.user;

import com.mirattic.sync.auth.MiratticAuth;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
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
	 * `email` is the Mirattic account's email, read live from Mirattic Auth (null if Auth can't be reached).
	 * `friendCode` is only ever shown to its owner, who shares it to be added as a friend.
	 */
	public record Me(String id, String email, String displayName, String friendCode, Visibility presenceVisibility,
			Visibility positionVisibility) {
	}

	public record PrivacyRequest(@NotNull Visibility presenceVisibility, @NotNull Visibility positionVisibility) {
	}

	private final UserRepository users;
	private final MiratticAuth auth;

	UserController(UserRepository users, MiratticAuth auth) {
		this.users = users;
		this.auth = auth;
	}

	@GetMapping("/me")
	Me me(@AuthenticationPrincipal Jwt jwt) {
		return me(load(jwt.getSubject()), jwt);
	}

	@PutMapping("/me/privacy")
	@Transactional
	Me updatePrivacy(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody PrivacyRequest req) {
		User me = load(jwt.getSubject());
		me.setPrivacy(req.presenceVisibility(), req.positionVisibility());
		return me(me, jwt);
	}

	@PostMapping("/me/friend-code")
	@Transactional
	Me regenerateFriendCode(@AuthenticationPrincipal Jwt jwt) {
		User me = load(jwt.getSubject());
		me.regenerateFriendCode();
		return me(me, jwt);
	}

	private Me me(User u, Jwt jwt) {
		return new Me(u.getId(), auth.email(jwt.getTokenValue()), u.getDisplayName(), u.getFriendCode(),
				u.getPresenceVisibility(), u.getPositionVisibility());
	}

	private User load(String id) {
		return users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
	}
}
