package com.mirattic.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;

/** Phase 9: deleting chat messages, reports, account deletion. */
class SafetyFlowTest extends IntegrationTest {

	@Autowired
	private JdbcTemplate jdbc;

	@Test
	void authorsAndHostsDeleteMessagesForEveryone() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		TestUser other = signup();
		TestUser stranger = signup();
		befriend(host, member);
		befriend(host, other);
		String roomId = room(host, member, other);
		String elsewhere = room(member, host); // the member's own room (a host is in one room at a time)
		Client memberWs = connect(member);
		Client otherWs = connect(other);

		String hostSaid = say(host, roomId, "from the host");
		String memberSaid = say(member, roomId, "from a member");
		String otherSaid = say(other, roomId, "from another member");

		deleteMessage(member, roomId, hostSaid).andExpect(status().isForbidden()); // not mine, not the host
		deleteMessage(stranger, roomId, hostSaid).andExpect(status().isNotFound());
		deleteMessage(member, elsewhere, memberSaid).andExpect(status().isNotFound()); // not in that room
		deleteMessage(member, roomId, memberSaid).andExpect(status().isNoContent());
		JsonNode gone = otherWs.nextOfType("chat:delete");
		assertThat(gone.path("roomId").asString()).isEqualTo(roomId);
		assertThat(gone.path("payload").path("id").asString()).isEqualTo(memberSaid);
		assertThat(memberWs.nextOfType("chat:delete")).isNotNull(); // my other apps too
		deleteMessage(host, roomId, otherSaid).andExpect(status().isNoContent()); // moderation
		deleteMessage(host, roomId, otherSaid).andExpect(status().isNotFound());

		// Deleted ones stay as placeholders with their text wiped.
		JsonNode history = body(call(HttpMethod.GET, "/api/rooms/" + roomId + "/messages", member.accessToken(), null));
		assertThat(history.findValuesAsString("text")).containsExactly("from the host", "", "");
		assertThat(history.findValues("deleted")).extracting(JsonNode::asBoolean).containsExactly(false, true, true);
		assertThat(jdbc.queryForObject("select count(*) from chat_messages where text in (?, ?)", Long.class,
				"from a member", "from another member")).isZero();
	}

	@Test
	void onlyWhatTheReporterCouldSeeIsReportable() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		TestUser stranger = signup();
		TestUser blocked = signup();
		befriend(me, friend);
		String roomId = room(me, friend);
		String theirs = say(friend, roomId, "rude words");
		String mine = say(me, roomId, "my words");
		String kept = say(friend, roomId, "more rude words");

		report(me, "{\"messageId\":\"%s\",\"reason\":\"HARASSMENT\",\"detail\":\"  twice  \"}".formatted(theirs))
				.andExpect(status().isNoContent());
		report(me, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(theirs)).andExpect(status().isNoContent());
		// The message is kept with the report, even after it is deleted.
		deleteMessage(friend, roomId, theirs).andExpect(status().isNoContent());
		assertThat(jdbc.queryForList("select message_text, detail, reason from reports where reporter_id = ?",
				me.id())).singleElement().satisfies(r -> {
					assertThat(r.get("message_text")).isEqualTo("rude words");
					assertThat(r.get("detail")).isEqualTo("twice");
					assertThat(r.get("reason")).isEqualTo("HARASSMENT");
				});

		report(me, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(mine)).andExpect(status().isBadRequest());
		report(stranger, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(mine)).andExpect(status().isNotFound());
		report(me, "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(friend.id())).andExpect(status().isNoContent());
		report(me, "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(stranger.id())).andExpect(status().isNotFound());
		report(me, "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(me.id())).andExpect(status().isBadRequest());
		call(HttpMethod.PUT, "/api/blocks/" + blocked.id(), me.accessToken(), null);
		report(me, "{\"userId\":\"%s\",\"reason\":\"SPAM\"}".formatted(blocked.id())).andExpect(status().isNoContent());
		report(me, "{\"reason\":\"SPAM\"}").andExpect(status().isBadRequest());
		report(me, "{\"userId\":\"%s\",\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(friend.id(), mine))
				.andExpect(status().isBadRequest());
		report(me, "{\"userId\":\"%s\",\"reason\":\"NOPE\"}".formatted(friend.id())).andExpect(status().isBadRequest());

		report(me, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(kept)).andExpect(status().isNoContent());
		for (int i = 4; i < 20; i++) {
			report(me, "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(friend.id())).andExpect(status().isNoContent());
		}
		report(me, "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(friend.id()))
				.andExpect(status().isTooManyRequests());
		// Repeating a report already made isn't a new one: still accepted at the limit.
		report(me, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(kept)).andExpect(status().isNoContent());
	}

	@Test
	void concurrentReportsStayWithinTheDailyLimitAndSaveAMessageOnce() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		befriend(me, friend);
		String message = say(friend, room(me, friend), "spam");
		ExecutorService pool = Executors.newFixedThreadPool(16);
		try {
			List<Future<Integer>> results = new ArrayList<>();
			for (int i = 0; i < 30; i++) {
				String body = i % 3 == 0 ? "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(message)
						: "{\"userId\":\"%s\",\"reason\":\"OTHER\"}".formatted(friend.id());
				results.add(pool.submit(() -> report(me, body).andReturn().getResponse().getStatus()));
			}
			for (Future<Integer> r : results) {
				assertThat(r.get()).isIn(204, 429);
			}
		} finally {
			pool.shutdown();
		}
		assertThat(jdbc.queryForObject("select count(*) from reports where reporter_id = ?", Long.class, me.id()))
				.isEqualTo(20);
		assertThat(jdbc.queryForObject("select count(*) from reports where reporter_id = ? and message_id is not null",
				Long.class, me.id())).isLessThanOrEqualTo(1);
	}

	@Test
	void deletingAnAccountRemovesItsDataAndTellsTheOthers() throws Exception {
		TestUser leaving = signup();
		TestUser friend = signup();
		TestUser host = signup();
		TestUser asked = signup();
		befriend(leaving, friend);
		befriend(host, leaving);
		befriend(host, friend);
		sendRequest(leaving, asked.friendCode());
		String hosted = room(leaving, friend);
		String joined = room(host, leaving, friend);
		say(leaving, joined, "mine");
		String kept = say(friend, joined, "theirs");
		report(host, "{\"userId\":\"%s\",\"reason\":\"SPAM\"}".formatted(leaving.id())).andExpect(status().isNoContent());
		report(leaving, "{\"messageId\":\"%s\",\"reason\":\"SPAM\"}".formatted(kept)).andExpect(status().isNoContent());
		Client leavingWs = connect(leaving);
		Client friendWs = connect(friend);
		Client askedWs = connect(asked);
		String lateTicket = ticket(leaving); // issued before, used after the deletion

		// Needs a fresh password sign-in of the same account (reauth → prompt=login at Auth).
		int revoked = AuthStub.REVOKED.size();
		deleteAccount(leaving, new Handoff("unknown", "x".repeat(43))).andExpect(status().isForbidden());
		deleteAccount(leaving, signIn(friend.id(), "x", true, Instant.now())).andExpect(status().isForbidden());
		deleteAccount(leaving, signIn(leaving.id(), "x", true, Instant.now().minusSeconds(600)))
				.andExpect(status().isForbidden());
		Handoff proof = signIn(leaving.id(), "x", true, Instant.now());
		deleteAccount(leaving, proof).andExpect(status().isNoContent());
		// Each re-auth was a login of its own (other user, stale, good): all three ended at Auth.
		assertThat(AuthStub.REVOKED.size() - revoked).isEqualTo(3);

		JsonNode gone = friendWs.nextOfType("chat:delete");
		assertThat(gone.path("roomId").asString()).isEqualTo(joined);
		assertThat(gone.path("payload").path("userId").asString()).isEqualTo(leaving.id());
		assertThat(friendWs.nextOfType("friend:update")).isNotNull();
		assertThat(askedWs.nextOfType("friend:update")).isNotNull();
		awaitClosed(leavingWs.session());

		call(HttpMethod.GET, "/api/me", leaving.accessToken(), null).andExpect(status().isUnauthorized());
		call(HttpMethod.POST, "/api/ws-ticket", leaving.accessToken(), null).andExpect(status().isUnauthorized());
		// Auth still knows the account (it owns it); Sync has no profile for it any more.
		call(HttpMethod.POST, "/api/auth/refresh", null, "{\"refreshToken\":\"%s\"}".formatted(leaving.refreshToken()))
				.andExpect(status().isUnauthorized());
		awaitClosed(open(lateTicket, new LinkedBlockingQueue<>()));

		call(HttpMethod.GET, "/api/rooms/" + hosted, friend.accessToken(), null).andExpect(status().isNotFound());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + joined, friend.accessToken(), null))
				.path("members").findValuesAsString("id")).containsExactlyInAnyOrder(host.id(), friend.id());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + joined + "/messages", friend.accessToken(), null))
				.findValuesAsString("text")).containsExactly("theirs");
		assertThat(body(call(HttpMethod.GET, "/api/friends", friend.accessToken(), null))
				.findValuesAsString("id")).containsExactly(host.id());
		assertThat(body(call(HttpMethod.GET, "/api/friends/requests", asked.accessToken(), null))
				.path("incoming")).isEmpty();
		for (String table : new String[] {"users where id", "room_members where user_id", "chat_messages where user_id",
				"friendships where requester_id = ? or addressee_id", "reports where reporter_id = ? or target_user_id"}) {
			Object[] args = table.contains("or") ? new Object[] {leaving.id(), leaving.id()} : new Object[] {leaving.id()};
			assertThat(jdbc.queryForObject("select count(*) from " + table + " = ?", Long.class, args)).as(table).isZero();
		}
	}

	@Test
	void miratticAccountDeletionOrderFromAuthDeletesTheProfileAndTellsTheOthers() throws Exception {
		TestUser leaving = signup();
		TestUser friend = signup();
		befriend(leaving, friend);
		String joined = room(friend, leaving);
		Client leavingWs = connect(leaving);
		Client friendWs = connect(friend);

		deletionOrder(order(leaving.id(), AuthStub.CLIENT_ID, "account_deletion")).andExpect(status().isNoContent());
		assertThat(friendWs.nextOfType("friend:update")).isNotNull();
		awaitClosed(leavingWs.session());
		call(HttpMethod.GET, "/api/me", leaving.accessToken(), null).andExpect(status().isUnauthorized());
		assertThat(body(call(HttpMethod.GET, "/api/rooms/" + joined, friend.accessToken(), null))
				.path("members").findValuesAsString("id")).containsExactly(friend.id());
		assertThat(jdbc.queryForObject("select count(*) from users where id = ?", Long.class, leaving.id())).isZero();

		// Same order again, or for a UID Sync never saw: nothing to do, still 204.
		deletionOrder(order(leaving.id(), AuthStub.CLIENT_ID, "account_deletion")).andExpect(status().isNoContent());
		deletionOrder(order(java.util.UUID.randomUUID().toString(), AuthStub.CLIENT_ID, "account_deletion"))
				.andExpect(status().isNoContent());
	}

	@Test
	void onlyAuthsDeletionOrderIsAccepted() throws Exception {
		TestUser u = signup();
		deletionOrder(u.accessToken()).andExpect(status().isUnauthorized());
		deletionOrder(AuthStub.sign(java.util.Map.of("sub", u.id(), "aud", AuthStub.CLIENT_ID)))
				.andExpect(status().isUnauthorized()); // ID-token shaped: no purpose
		deletionOrder(order(u.id(), "mirattic-flow", "account_deletion")).andExpect(status().isUnauthorized());
		deletionOrder("not-a-jwt").andExpect(status().isUnauthorized());
		deletionOrder(null).andExpect(status().isUnauthorized());
		// Longer than Auth's one minute, or also carrying a scope: not a deletion order.
		deletionOrder(AuthStub.sign(java.util.Map.of("sub", u.id(), "aud", AuthStub.CLIENT_ID, "purpose",
				"account_deletion"))).andExpect(status().isUnauthorized());
		String scoped = AuthStub.sign(java.util.Map.of("sub", u.id(), "aud", AuthStub.CLIENT_ID, "purpose",
				"account_deletion", "scope", java.util.List.of("openid"), "exp", new java.util.Date(
						System.currentTimeMillis() + 60_000)));
		deletionOrder(scoped).andExpect(status().isUnauthorized());
		// A one-minute order used 10 s after it expired (inside the decoder's usual 60 s skew), or issued in the future.
		long now = System.currentTimeMillis();
		deletionOrder(AuthStub.sign(java.util.Map.of("sub", u.id(), "aud", AuthStub.CLIENT_ID, "purpose",
				"account_deletion", "iat", new java.util.Date(now - 70_000), "exp", new java.util.Date(now - 10_000))))
				.andExpect(status().isUnauthorized());
		deletionOrder(AuthStub.sign(java.util.Map.of("sub", u.id(), "aud", AuthStub.CLIENT_ID, "purpose",
				"account_deletion", "iat", new java.util.Date(now + 30_000), "exp", new java.util.Date(now + 60_000))))
				.andExpect(status().isUnauthorized());
		// ...and a deletion order is never an API token.
		call(HttpMethod.GET, "/api/me", scoped, null).andExpect(status().isUnauthorized());
		call(HttpMethod.GET, "/api/me", u.accessToken(), null).andExpect(status().isOk());
	}

	@Test
	void concurrentCopiesOfADeletionOrderAllGet204() throws Exception {
		TestUser u = signup();
		String order = order(u.id(), AuthStub.CLIENT_ID, "account_deletion");
		var pool = java.util.concurrent.Executors.newFixedThreadPool(4);
		try {
			var results = new java.util.ArrayList<java.util.concurrent.Future<Integer>>();
			for (int i = 0; i < 4; i++) {
				results.add(pool.submit(() -> deletionOrder(order).andReturn().getResponse().getStatus()));
			}
			for (var r : results) {
				assertThat(r.get()).isEqualTo(204);
			}
		} finally {
			pool.shutdown();
		}
		assertThat(jdbc.queryForObject("select count(*) from users where id = ?", Long.class, u.id())).isZero();
	}

	/** As Auth signs one: one minute. */
	private static String order(String uid, String audience, String purpose) {
		return AuthStub.sign(java.util.Map.of("sub", uid, "aud", audience, "purpose", purpose, "exp",
				new java.util.Date(System.currentTimeMillis() + 60_000)));
	}

	private ResultActions deletionOrder(String token) throws Exception {
		return call(HttpMethod.POST, "/api/internal/account-deletion", token, null);
	}

	private static void awaitClosed(WebSocketSession session) throws InterruptedException {
		for (int i = 0; i < 30 && session.isOpen(); i++) {
			TimeUnit.MILLISECONDS.sleep(100);
		}
		assertThat(session.isOpen()).isFalse();
	}

	private String room(TestUser host, TestUser... invitees) throws Exception {
		StringBuilder ids = new StringBuilder();
		for (TestUser u : invitees) {
			ids.append(ids.isEmpty() ? "" : ",").append('"').append(u.id()).append('"');
		}
		String roomId = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(), """
				{"content":{"provider":"mock","contentId":"c1","title":"Fake"},"inviteIds":[%s]}""".formatted(ids)))
				.path("id").asString();
		for (TestUser u : invitees) { // invited, then in (decision 85)
			call(HttpMethod.POST, "/api/rooms/" + roomId + "/invitation", u.accessToken(), null).andExpect(status().isOk());
		}
		return roomId;
	}

	/** Sends a chat message over a fresh socket and returns its id. */
	private String say(TestUser u, String roomId, String text) throws Exception {
		Client ws = connect(u);
		ws.send("{\"type\":\"chat:message\",\"roomId\":\"%s\",\"payload\":{\"text\":\"%s\"}}".formatted(roomId, text));
		String id = ws.nextOfType("chat:message").path("payload").path("id").asString();
		ws.session().close();
		return id;
	}

	private ResultActions deleteMessage(TestUser u, String roomId, String messageId) throws Exception {
		return call(HttpMethod.DELETE, "/api/rooms/" + roomId + "/messages/" + messageId, u.accessToken(), null);
	}

	private ResultActions report(TestUser u, String jsonBody) throws Exception {
		return call(HttpMethod.POST, "/api/reports", u.accessToken(), jsonBody);
	}

	private ResultActions deleteAccount(TestUser u, Handoff proof) throws Exception {
		return call(HttpMethod.DELETE, "/api/me", u.accessToken(),
				"{\"code\":\"%s\",\"verifier\":\"%s\"}".formatted(proof.code(), proof.verifier()));
	}
}
