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

	public record Me(String id, String email, String displayName, Visibility presenceVisibility,
			Visibility positionVisibility) {
		static Me of(User u) {
			return new Me(u.getId(), u.getEmail(), u.getDisplayName(), u.getPresenceVisibility(),
					u.getPositionVisibility());
		}
	}

	public record PrivacyRequest(@NotNull Visibility presenceVisibility, @NotNull Visibility positionVisibility) {
	}

	private final UserRepository users;
	private final BlockRepository blocks;

	UserController(UserRepository users, BlockRepository blocks) {
		this.users = users;
		this.blocks = blocks;
	}

	@GetMapping("/me")
	Me me(@AuthenticationPrincipal Jwt jwt) {
		return Me.of(load(jwt.getSubject()));
	}

	@PutMapping("/me/privacy")
	@Transactional
	Me updatePrivacy(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody PrivacyRequest req) {
		User me = load(jwt.getSubject());
		me.setPrivacy(req.presenceVisibility(), req.positionVisibility());
		return Me.of(me);
	}

	// Exact email match only, so the user base can't be enumerated by name.
	@GetMapping("/users/search")
	List<UserSummary> search(@AuthenticationPrincipal Jwt jwt, @RequestParam String email) {
		String myId = jwt.getSubject();
		return users.findByEmail(email.trim().toLowerCase(Locale.ROOT))
				.filter(u -> !u.getId().equals(myId) && !blocks.existsBetween(myId, u.getId()))
				.map(UserSummary::of)
				.stream().toList();
	}

	private User load(String id) {
		return users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
	}
}
