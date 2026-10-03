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
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
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

	/** Auth signs orders for one minute; a longer one is not Auth's. */
	static final Duration ORDER_LIFETIME = Duration.ofMinutes(1);

	/** Clock difference allowed between Auth and Sync for an order (the shared decoder's own allows 60 s). */
	static final Duration ORDER_CLOCK_SKEW = Duration.ofSeconds(5);

	private final AccountService accounts;
	private final RoomService rooms;
	private final SocketHub hub;
	private final Handoffs handoffs;
	private final MiratticAuth auth;
	private final JwtDecoder deletionOrders;

	AccountController(AccountService accounts, RoomService rooms, SocketHub hub, Handoffs handoffs, MiratticAuth auth) {
		this.deletionOrders = auth.decoder(order("account_deletion"));
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
		// No profile (never signed in to Sync, already deleted, a concurrent copy of this order): nothing to do.
		accounts.deleteIfExists(order.getSubject()).ifPresent(deleted -> announce(order.getSubject(), deleted));
		return ResponseEntity.noContent().build();
	}

	/**
	 * An Auth order with this purpose only (account_deletion, admin_read): no scope (never an API token), issued for
	 * at most a minute and used within it (give or take {@link #ORDER_CLOCK_SKEW}).
	 */
	public static OAuth2TokenValidator<Jwt> order(String purpose) {
		return jwt -> {
			Instant now = Instant.now();
			Instant iat = jwt.getIssuedAt();
			Instant exp = jwt.getExpiresAt();
			boolean ok = purpose.equals(jwt.getClaimAsString("purpose")) && !jwt.hasClaim("scope")
					&& iat != null && exp != null && !exp.isAfter(iat.plus(ORDER_LIFETIME))
					&& !iat.isAfter(now.plus(ORDER_CLOCK_SKEW)) && now.isBefore(exp.plus(ORDER_CLOCK_SKEW));
			return ok ? OAuth2TokenValidatorResult.success()
					: OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "not a " + purpose + " order", null));
		};
	}

	/** As after a leave / unfriend, the others are told; my sockets close. */
	private void announce(String me, AccountService.Deleted deleted) {
		for (RoomService.Departure d : deleted.rooms()) {
			if (d.left().closed()) {
				hub.closeRoom(d.roomId());
				rooms.announceClosed(d.roomId(), me, d.left());
			} else {
				hub.removeFromRoom(d.roomId(), me);
				// My messages are gone from the database: the others drop them from their screens too.
				ServerEvent gone = new ServerEvent("chat:delete", d.roomId(), me, null, System.currentTimeMillis(),
						Map.of("userId", me));
				d.left().memberIds().forEach(id -> hub.sendEvent(id, gone));
				rooms.announce(d.roomId(), d.left().memberIds());
			}
		}
		deleted.contacts().forEach(id -> hub.sendEvent(id, "friend:update", null, null));
		hub.disconnect(me);
	}
}
