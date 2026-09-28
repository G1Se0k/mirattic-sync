package com.mirattic.sync.room;

import com.mirattic.sync.ws.ServerEvent;
import com.mirattic.sync.ws.SocketHub;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/rooms")
class RoomController {

	record CreateRoom(@NotNull @Valid RoomContent content, @NotNull @Size(max = 32) List<String> inviteIds) {
	}

	private final RoomService rooms;
	private final SocketHub hub;

	RoomController(RoomService rooms, SocketHub hub) {
		this.rooms = rooms;
		this.hub = hub;
	}

	/** Creates a room hosted by the caller; invitees get `room:invite` with the room. */
	@PostMapping
	RoomService.RoomView create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateRoom body) {
		RoomService.RoomView room = rooms.create(jwt.getSubject(), body.content(), body.inviteIds());
		ServerEvent invite = new ServerEvent("room:invite", room.id(), jwt.getSubject(), null,
				System.currentTimeMillis(), room);
		for (RoomService.MemberView m : room.members()) {
			if (!m.user().id().equals(jwt.getSubject())) {
				hub.sendEvent(m.user().id(), invite);
			}
		}
		return room;
	}

	@GetMapping
	List<RoomService.RoomView> mine(@AuthenticationPrincipal Jwt jwt) {
		return rooms.mine(jwt.getSubject());
	}

	@GetMapping("/{id}")
	RoomService.RoomView get(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		return rooms.get(jwt.getSubject(), id);
	}

	/** The last 100 chat messages, oldest first. New ones arrive as `chat:message`. */
	@GetMapping("/{id}/messages")
	List<ChatMessage.View> messages(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		return rooms.history(jwt.getSubject(), id);
	}

	/** Leave (or decline an invite). The host leaving closes the room; members then get 404 on refetch. */
	@DeleteMapping("/{id}/members/me")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void leave(@AuthenticationPrincipal Jwt jwt, @PathVariable String id) {
		RoomService.Left left = rooms.leave(jwt.getSubject(), id);
		if (left.closed()) {
			hub.closeRoom(id);
		} else {
			hub.removeFromRoom(id, jwt.getSubject());
		}
		rooms.announce(id, left.memberIds());
	}
}
