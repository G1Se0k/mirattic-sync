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
import com.mirattic.sync.user.UserRepository;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AccountController {

	/** A handoff from a sign-in started with reauth=true (the password typed again at Mirattic Auth). */
	record DeleteAccount(@NotBlank @Size(max = 128) String code, @NotBlank @Size(max = 128) String verifier) {
	}

	/** Where Auth sends a Mirattic account deletion (SecurityConfig lets its bearer through unparsed). */
	public static final String DELETION_ORDER = "/api/internal/account-deletion";

	/** How recent the password sign-in behind the handoff must be. */
	static final Duration REAUTH_WINDOW = Duration.ofMinutes(5);

	private final AccountService accounts;
	private final RoomService rooms;
	private final SocketHub hub;
	private final Handoffs handoffs;
	private final MiratticAuth auth;
	private final UserRepository users;
	private final JwtDecoder deletionOrders;

	AccountController(AccountService accounts, RoomService rooms, SocketHub hub, Handoffs handoffs, MiratticAuth auth,
			UserRepository users) {
		this.users = users;
		this.deletionOrders = auth.decoder(jwt -> "account_deletion".equals(jwt.getClaimAsString("purpose"))
				? OAuth2TokenValidatorResult.success()
				: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "not a deletion order", null)));
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
		announce(me, accounts.delete(me));
	}

	/**
	 * Mirattic account deletion: Auth's order (Auth docs/api.md "Account Deletion"), a one-minute JWT signed by Auth
	 * with aud = mirattic-sync, sub = the UID and purpose = account_deletion. Only that purpose is accepted: not an
	 * access token, not an ID token. Idempotent: no Sync profile is 204 too.
	 */
	@PostMapping(DELETION_ORDER)
	ResponseEntity<Void> deleteByAuth(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
		Jwt order;
		try {
			if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
				throw new JwtException("no bearer");
			}
			order = deletionOrders.decode(authorization.substring(7));
		} catch (JwtException e) {
			return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
		}
		String uid = order.getSubject();
		if (users.existsById(uid)) {
			announce(uid, accounts.delete(uid));
		}
		return ResponseEntity.noContent().build();
	}

	/** As after a leave / unfriend, the others are told; my sockets close. */
	private void announce(String me, AccountService.Deleted deleted) {
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
