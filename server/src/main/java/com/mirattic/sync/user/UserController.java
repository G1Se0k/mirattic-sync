package com.mirattic.sync.user;

import com.mirattic.sync.auth.MiratticAuth;
import com.mirattic.sync.presence.RoomsChanged;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Objects;
import org.springframework.context.ApplicationEventPublisher;
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
	public record Me(String id, String email, String displayName, String avatarUrl, String friendCode, Visibility presenceVisibility,
			Visibility positionVisibility, boolean friendCodeOnly) {
	}

	/** Each setting left out is unchanged: a client sends only the one it changes (before 1.2.2: both visibilities). */
	public record PrivacyRequest(Visibility presenceVisibility, Visibility positionVisibility, Boolean friendCodeOnly) {
	}

	private final UserRepository users;
	private final MiratticAuth auth;
	private final ApplicationEventPublisher events;

	UserController(UserRepository users, MiratticAuth auth, ApplicationEventPublisher events) {
		this.events = events;
		this.users = users;
		this.auth = auth;
	}

	@GetMapping("/me")
	@Transactional
	Me me(@AuthenticationPrincipal Jwt jwt) {
		return me(load(jwt.getSubject()), jwt);
	}

	@PutMapping("/me/privacy")
	@Transactional
	Me updatePrivacy(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody PrivacyRequest req) {
		User me = load(jwt.getSubject());
		me.setPrivacy(Objects.requireNonNullElse(req.presenceVisibility(), me.getPresenceVisibility()),
				Objects.requireNonNullElse(req.positionVisibility(), me.getPositionVisibility()));
		if (req.friendCodeOnly() != null) {
			me.setFriendCodeOnly(req.friendCodeOnly());
		}
		events.publishEvent(new RoomsChanged(List.of(me.getId()))); // friends see what the new setting shows, once saved
		return me(me, jwt);
	}

	@PostMapping("/me/friend-code")
	@Transactional
	Me regenerateFriendCode(@AuthenticationPrincipal Jwt jwt) {
		User me = load(jwt.getSubject());
		me.regenerateFriendCode();
		return me(me, jwt);
	}

	/** With the email and name read live from Auth: a name changed there is taken here (decision 99). */
	private Me me(User u, Jwt jwt) {
		MiratticAuth.UserInfo info = auth.userInfo(jwt.getTokenValue());
		if (info != null) {
			boolean changed = u.syncName(info.name()); // stored only if it changed (none or blank: kept)
			changed |= u.syncAvatar(info.avatarUrl()); // the photo as Auth has it now, none included
			if (changed) {
				events.publishEvent(new ProfileChanged(u.getId())); // open friend lists and rooms show it, once saved
			}
		}
		return new Me(u.getId(), info == null ? null : info.email(), u.getDisplayName(), u.getAvatarUrl(), u.getFriendCode(),
				u.getPresenceVisibility(), u.getPositionVisibility(), u.isFriendCodeOnly());
	}

	private User load(String id) {
		return users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
	}
}
