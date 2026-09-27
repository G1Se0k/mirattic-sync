package com.mirattic.sync.ws;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/**
 * One-time, 30-second tickets for the WebSocket handshake, so access tokens never appear in URLs/logs.
 * ponytail: in-memory, single-instance only; move to Redis alongside presence.
 */
@Service
public class TicketService {

	static final long TTL_MS = 30_000;

	private record Ticket(String userId, long expiresAt) {
	}

	private static final SecureRandom RANDOM = new SecureRandom();
	private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();

	public String issue(String userId) {
		long now = System.currentTimeMillis();
		tickets.values().removeIf(t -> t.expiresAt() <= now);
		byte[] bytes = new byte[32];
		RANDOM.nextBytes(bytes);
		String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
		tickets.put(ticket, new Ticket(userId, now + TTL_MS));
		return ticket;
	}

	/** @return the user id, or null if the ticket is unknown, used or expired. */
	public String consume(String ticket) {
		Ticket t = ticket == null ? null : tickets.remove(ticket);
		return t != null && t.expiresAt() > System.currentTimeMillis() ? t.userId() : null;
	}
}
