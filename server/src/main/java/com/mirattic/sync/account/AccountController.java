package com.mirattic.sync.account;

import com.mirattic.sync.auth.Handoffs;
import com.mirattic.sync.auth.MiratticAuth;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
class AccountController {

	/** A handoff from a sign-in started with reauth=true (the password typed again at Mirattic Auth). */
	record DeleteAccount(@NotBlank @Size(max = 128) String code, @NotBlank @Size(max = 128) String verifier) {
	}

	/** How recent the password sign-in behind the handoff must be. */
	static final Duration REAUTH_WINDOW = Duration.ofMinutes(5);

	private final AccountService accounts;
	private final RoomService rooms;
	private final SocketHub hub;
	private final Handoffs handoffs;
	private final MiratticAuth auth;

	AccountController(AccountService accounts, RoomService rooms, SocketHub hub, Handoffs handoffs, MiratticAuth auth) {
		this.accounts = accounts;
		this.rooms = rooms;
		this.hub = hub;
		this.handoffs = handoffs;
		this.auth = auth;
	}

	/**
	 * Deletes my Sync profile and data. A stolen access token alone can't: it needs a fresh password sign-in of
	 * the same UID (403 otherwise; not 401, which would make clients refresh and retry). Then, as after a leave /
	 * unfriend, the others are told.
	 */
	@DeleteMapping("/api/me")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void delete(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody DeleteAccount body) {
		String me = jwt.getSubject();
		Handoffs.Handoff proof = handoffs.redeem(body.code(), body.verifier());
		if (proof == null) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "sign in again to delete");
		}
		// The re-auth was a login of its own: end it whatever happens next.
		auth.revoke(proof.tokens().refreshToken());
		if (!me.equals(proof.tokens().user().id()) || proof.authTime().isBefore(Instant.now().minus(REAUTH_WINDOW))) {
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "sign in again to delete");
		}
		AccountService.Deleted deleted = accounts.delete(me);
		for (RoomService.Departure d : deleted.rooms()) {
			if (d.left().closed()) {
				hub.closeRoom(d.roomId());
			} else {
				hub.removeFromRoom(d.roomId(), me);
				// My messages are gone from the database: the others drop them from their screens too.
				ServerEvent gone = new ServerEvent("chat:delete", d.roomId(), me, null, System.currentTimeMillis(),
						Map.of("userId", me));
				d.left().memberIds().forEach(id -> hub.sendEvent(id, gone));
			}
			rooms.announce(d.roomId(), d.left().memberIds());
		}
		deleted.contacts().forEach(id -> hub.sendEvent(id, "friend:update", null, null));
		hub.disconnect(me);
	}
}
