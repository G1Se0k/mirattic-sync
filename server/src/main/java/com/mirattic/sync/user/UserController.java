package com.mirattic.sync.user;

import com.mirattic.sync.friend.BlockRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class UserController {

	/** `email` is the contact email of the user's first identity that has one; null for email-less OAuth users. */
	public record Me(String id, String email, List<IdentityProvider> providers, String displayName,
			Visibility presenceVisibility, Visibility positionVisibility) {
	}

	public record PrivacyRequest(@NotNull Visibility presenceVisibility, @NotNull Visibility positionVisibility) {
	}

	private final UserRepository users;
	private final UserIdentityRepository identities;
	private final BlockRepository blocks;

	UserController(UserRepository users, UserIdentityRepository identities, BlockRepository blocks) {
		this.users = users;
		this.identities = identities;
		this.blocks = blocks;
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

	// Exact email match only, so the user base can't be enumerated by name.
	@GetMapping("/users/search")
	List<UserSummary> search(@AuthenticationPrincipal Jwt jwt, @RequestParam String email) {
		String myId = jwt.getSubject();
		List<String> ids = identities.findUserIdsByEmail(email.trim().toLowerCase(Locale.ROOT)).stream()
				.filter(id -> !id.equals(myId) && !blocks.existsBetween(myId, id))
				.toList();
		return users.findAllById(ids).stream().map(UserSummary::of).toList();
	}

	private Me me(User u) {
		List<UserIdentity> list = identities.findByUserId(u.getId());
		String email = list.stream().map(UserIdentity::getEmail).filter(e -> e != null).findFirst().orElse(null);
		return new Me(u.getId(), email, list.stream().map(UserIdentity::getProvider).distinct().toList(),
				u.getDisplayName(), u.getPresenceVisibility(), u.getPositionVisibility());
	}

	private User load(String id) {
		return users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
	}
}
