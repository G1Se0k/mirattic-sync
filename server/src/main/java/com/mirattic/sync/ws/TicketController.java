package com.mirattic.sync.ws;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class TicketController {

	record TicketResponse(String ticket) {
	}

	private final TicketService tickets;

	TicketController(TicketService tickets) {
		this.tickets = tickets;
	}

	@PostMapping("/api/ws-ticket")
	TicketResponse issue(@AuthenticationPrincipal Jwt jwt) {
		return new TicketResponse(tickets.issue(jwt.getSubject()));
	}
}
