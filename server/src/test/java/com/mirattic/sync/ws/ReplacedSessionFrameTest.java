package com.mirattic.sync.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.mirattic.sync.IntegrationTest;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/** Decision 89: a frame from a session another device replaced counts for nothing, whenever it arrives. */
class ReplacedSessionFrameTest extends IntegrationTest {

	@Autowired
	private SocketHandler handler;
	@Autowired
	private SocketHub hub;

	@Test
	void aReplacedSessionsFrameHasNoEffect() throws Exception {
		TestUser me = signup();
		TestUser friend = signup();
		befriend(me, friend);
		String roomId = body(call(HttpMethod.POST, "/api/rooms", me.accessToken(),
				"{\"content\":{\"provider\":\"mock\",\"contentId\":\"c1\",\"title\":\"Fake\",\"durationMs\":600000},"
						+ "\"inviteIds\":[\"" + friend.id() + "\"]}")).path("id").asString();
		call(HttpMethod.POST, "/api/rooms/" + roomId + "/invitation", friend.accessToken(), null)
				.andExpect(status().isOk());
		Client friendWs = connect(friend);

		// My first device (its session registered as the current one), then another device takes over.
		WebSocketSession replaced = mock(WebSocketSession.class);
		Map<String, Object> attributes = new HashMap<>(Map.of(SocketHandler.USER_ID, me.id(), "out", replaced));
		when(replaced.getAttributes()).thenReturn(attributes);
		hub.add(me.id(), replaced);
		assertThat(hub.isCurrent(me.id(), replaced)).isTrue();
		connect(me);
		for (int i = 0; i < 100 && hub.isCurrent(me.id(), replaced); i++) { // the switch lands just after the handshake
			Thread.sleep(20);
		}
		assertThat(hub.isCurrent(me.id(), replaced)).isFalse();

		// A frame of the replaced session still being delivered.
		handler.handleTextMessage(replaced, new TextMessage(
				"{\"type\":\"chat:message\",\"roomId\":\"%s\",\"payload\":{\"text\":\"late\"}}".formatted(roomId)));
		assertThat(friendWs.nextOfType("chat:message")).isNull();
	}
}
