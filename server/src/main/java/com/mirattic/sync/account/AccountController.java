package com.mirattic.sync.account;

import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
class AccountController {

	record DeleteAccount(@NotBlank @Size(max = 128) String password) {
	}

	private final AccountService accounts;
	private final RoomService rooms;
	private final SocketHub hub;

	AccountController(AccountService accounts, RoomService rooms, SocketHub hub) {
		this.accounts = accounts;
		this.rooms = rooms;
		this.hub = hub;
	}

	/** Deletes my account and data (403 wrong password). Then, as after a leave / unfriend, the others are told. */
	@DeleteMapping("/api/me")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void delete(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody DeleteAccount body) {
		String me = jwt.getSubject();
		AccountService.Deleted deleted = accounts.delete(me, body.password());
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
