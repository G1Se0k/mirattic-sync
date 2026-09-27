package com.mirattic.sync.friend;

import com.mirattic.sync.user.UserSummary;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Friend graph changes push `friend:update` to both users after the transaction commits, so clients refetch. */
@RestController
@RequestMapping("/api")
class FriendController {

	record FriendRequestBody(@NotBlank String userId) {
	}

	private final FriendService friends;
	private final SocketHub hub;

	FriendController(FriendService friends, SocketHub hub) {
		this.friends = friends;
		this.hub = hub;
	}

	@GetMapping("/friends")
	List<FriendService.FriendView> list(@AuthenticationPrincipal Jwt jwt) {
		return friends.friends(jwt.getSubject());
	}

	@GetMapping("/friends/requests")
	FriendService.FriendRequests requests(@AuthenticationPrincipal Jwt jwt) {
		return friends.requests(jwt.getSubject());
	}

	@PostMapping("/friends/requests")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void sendRequest(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody FriendRequestBody body) {
		notify(jwt.getSubject(), friends.sendRequest(jwt.getSubject(), body.userId()));
	}

	@PostMapping("/friends/requests/{id}/accept")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void accept(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		notify(jwt.getSubject(), friends.accept(jwt.getSubject(), id));
	}

	@DeleteMapping("/friends/requests/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void deleteRequest(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		notify(jwt.getSubject(), friends.deleteRequest(jwt.getSubject(), id));
	}

	@DeleteMapping("/friends/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void remove(@AuthenticationPrincipal Jwt jwt, @PathVariable String userId) {
		friends.removeFriend(jwt.getSubject(), userId);
		notify(jwt.getSubject(), userId);
	}

	@GetMapping("/blocks")
	List<UserSummary> blocked(@AuthenticationPrincipal Jwt jwt) {
		return friends.blocked(jwt.getSubject());
	}

	@PutMapping("/blocks/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void block(@AuthenticationPrincipal Jwt jwt, @PathVariable String userId) {
		friends.block(jwt.getSubject(), userId);
		notify(jwt.getSubject(), userId);
	}

	@DeleteMapping("/blocks/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void unblock(@AuthenticationPrincipal Jwt jwt, @PathVariable String userId) {
		friends.unblock(jwt.getSubject(), userId);
	}

	private void notify(String a, String b) {
		hub.sendEvent(a, "friend:update", null, null);
		hub.sendEvent(b, "friend:update", null, null);
	}
}
