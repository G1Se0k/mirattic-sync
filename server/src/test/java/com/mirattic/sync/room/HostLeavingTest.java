package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import com.mirattic.sync.ws.EmptyRooms;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/** Decision 90: the host leaving the room closes it, and the members are told. A short wait here instead of 30 s. */
@TestPropertySource(properties = "app.host-gone-close-ms=1000")
class HostLeavingTest extends IntegrationTest {

	private static final String CONTENT = """
			{"provider":"mock","contentId":"c1","title":"Fake","durationMs":600000}""";

	/** A room of `host` that `member` joined by its code; both connected and in it. */
	private record Room(String id, Client hostWs, Client memberWs) {
	}

	private Room together(TestUser host, TestUser member) throws Exception {
		JsonNode room = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT)));
		String id = room.path("id").asString();
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(room.path("code").asString()))
				.andExpect(status().isOk());
		Client memberWs = connect(member);
		memberWs.send(event("room:join", id, "{}"));
		memberWs.nextOfType("playback:update");
		Client hostWs = connect(host);
		hostWs.send(event("room:join", id, "{}"));
		hostWs.nextOfType("playback:update");
		memberWs.nextOfType("room:update"); // the host's join
		return new Room(id, hostWs, memberWs);
	}

	@Test
	void theHostsConnectionGoneClosesTheRoomAfterTheWait() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);

		room.hostWs().session().close(); // panel or window closed
		JsonNode closed = room.memberWs().nextOfType("room:closed");
		assertThat(closed.path("roomId").asString()).isEqualTo(room.id());
		assertThat(closed.path("userId").asString()).isEqualTo(host.id());
		assertThat(closed.path("payload").path("title").asString()).isEqualTo("Fake"); // for the notice
		assertThat(room.memberWs().nextOfType("room:update")).isNotNull();
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isNotFound());
	}

	@Test
	void theHostBackWithinTheWaitKeepsTheRoom() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);

		room.hostWs().send(event("room:leave", room.id(), "{}"));
		room.memberWs().nextOfType("room:update"); // the leave applied
		room.hostWs().send(event("room:join", room.id(), "{}"));
		room.hostWs().nextOfType("playback:update");
		Thread.sleep(2000); // past the wait
		assertThat(room.memberWs().nextOfType("room:closed")).isNull();
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());

		// Gone again: the new wait closes it.
		room.hostWs().send(event("room:leave", room.id(), "{}"));
		assertThat(room.memberWs().nextOfType("room:closed")).isNotNull();
	}

	@Test
	void aRoomHandedOverMeanwhileStays() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);

		room.hostWs().send(event("room:leave", room.id(), "{}"));
		room.memberWs().nextOfType("room:update");
		call(HttpMethod.POST, "/api/rooms/" + room.id() + "/host", host.accessToken(), "{\"userId\":\"%s\"}".formatted(member.id()))
				.andExpect(status().is2xxSuccessful());
		Thread.sleep(2000);
		assertThat(room.memberWs().nextOfType("room:closed")).isNull();
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());
	}

	@Test
	void theHostLeavingByTheButtonClosesAtOnce() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		TestUser invitee = signup();
		befriend(host, invitee);
		Room room = together(host, member);
		call(HttpMethod.POST, "/api/rooms/" + room.id() + "/invites", host.accessToken(), "{\"userIds\":[\"%s\"]}".formatted(invitee.id()))
				.andExpect(status().isOk());
		Client inviteeWs = connect(invitee);

		call(HttpMethod.DELETE, "/api/rooms/" + room.id() + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		assertThat(room.memberWs().nextOfType("room:closed").path("roomId").asString()).isEqualTo(room.id());
		assertThat(inviteeWs.nextOfType("room:update")).isNotNull(); // the invitation's banner goes
		assertThat(room.hostWs().nextOfType("room:closed")).isNull(); // the host left: nothing to tell them
		assertThat(inviteeWs.nextOfType("room:closed")).isNull(); // never in it: no notice
	}

	@Test
	void aMemberOfflineWhenItClosedIsToldOnReconnecting() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);

		room.memberWs().session().close(); // offline (browser closed, network down)
		assertThat(room.hostWs().nextOfType("room:update")).isNotNull(); // its disconnect handled
		call(HttpMethod.DELETE, "/api/rooms/" + room.id() + "/members/me", host.accessToken(), null)
				.andExpect(status().isNoContent());
		Client back = connect(member);
		JsonNode closed = back.nextOfType("room:closed");
		assertThat(closed.path("roomId").asString()).isEqualTo(room.id());
		assertThat(closed.path("payload").path("title").asString()).isEqualTo("Fake");

		// Not acknowledged: every connection gets it again. Acknowledged: no more.
		back = connect(member);
		assertThat(back.nextOfType("room:closed")).isNotNull();
		back.send(event("room:closed:ack", room.id(), "null"));
		back.send("{\"type\":\"sync:request\",\"reqId\":\"done\",\"payload\":null}");
		back.nextOfType("sync:response"); // the ack was handled before this
		assertThat(connect(member).nextOfType("room:closed")).isNull();
	}

	@Test
	void backToTheListClosesTheHostsRoomButNotAMembers() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);

		// A member going back to the list stays in the room.
		assertThat(body(call(HttpMethod.POST, "/api/rooms/" + room.id() + "/back", member.accessToken(), null)
				.andExpect(status().isOk())).path("closed").asBoolean()).isFalse();
		assertThat(room.memberWs().nextOfType("room:closed")).isNull();
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());

		// The host: asked to confirm first (409, nothing happens), then closed at once, the members told.
		call(HttpMethod.POST, "/api/rooms/" + room.id() + "/back", host.accessToken(), null).andExpect(status().isConflict());
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());
		assertThat(body(call(HttpMethod.POST, "/api/rooms/" + room.id() + "/back", host.accessToken(), "{\"confirmed\":true}")
				.andExpect(status().isOk())).path("closed").asBoolean()).isTrue();
		assertThat(room.memberWs().nextOfType("room:closed").path("roomId").asString()).isEqualTo(room.id());
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isNotFound());
	}

	@Test
	void backAfterAHandOverIsAMembersBack() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		Room room = together(host, member);
		call(HttpMethod.POST, "/api/rooms/" + room.id() + "/host", host.accessToken(), "{\"userId\":\"%s\"}".formatted(member.id()))
				.andExpect(status().is2xxSuccessful());

		// The former host's back (e.g. a screen that still showed them as host, confirmed there): the room stays.
		assertThat(body(call(HttpMethod.POST, "/api/rooms/" + room.id() + "/back", host.accessToken(), "{\"confirmed\":true}")
				.andExpect(status().isOk())).path("closed").asBoolean()).isFalse();
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());

		// The new host whose screen still showed them as a member: asked to confirm (409).
		call(HttpMethod.POST, "/api/rooms/" + room.id() + "/back", member.accessToken(), null).andExpect(status().isConflict());
		call(HttpMethod.GET, "/api/rooms/" + room.id(), member.accessToken(), null).andExpect(status().isOk());
	}

	@Autowired
	private EmptyRooms sweeps;

	@Test
	void theSweepClosesARoomItsHostIsntInEvenWithMembersInIt() throws Exception {
		TestUser host = signup();
		TestUser member = signup();
		JsonNode created = body(call(HttpMethod.POST, "/api/rooms", host.accessToken(),
				"{\"content\":%s,\"inviteIds\":[]}".formatted(CONTENT)));
		String id = created.path("id").asString();
		call(HttpMethod.POST, "/api/rooms/join", member.accessToken(), "{\"code\":\"%s\"}".formatted(created.path("code").asString()))
				.andExpect(status().isOk());
		Client memberWs = connect(member); // e.g. after a server restart that forgot the host's wait
		memberWs.send(event("room:join", id, "{}"));
		memberWs.nextOfType("playback:update");

		sweeps.sweep(); // the host away once: kept (a reconnect may be under way)
		call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null).andExpect(status().isOk());
		sweeps.sweep(); // still away: closed, the member told
		assertThat(memberWs.nextOfType("room:closed").path("roomId").asString()).isEqualTo(id);
		call(HttpMethod.GET, "/api/rooms/" + id, member.accessToken(), null).andExpect(status().isNotFound());
	}

	private static String event(String type, String roomId, String payload) {
		return "{\"type\":\"%s\",\"roomId\":\"%s\",\"payload\":%s}".formatted(type, roomId, payload);
	}
}
