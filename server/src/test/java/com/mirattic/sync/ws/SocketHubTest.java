package com.mirattic.sync.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

class SocketHubTest {

	private final SocketHub hub = new SocketHub(JsonMapper.builder().build());

	private static WebSocketSession session(String userId) {
		WebSocketSession s = mock(WebSocketSession.class);
		Map<String, Object> attributes = new HashMap<>(Map.of(SocketHandler.USER_ID, userId));
		when(s.getAttributes()).thenReturn(attributes);
		return s;
	}

	@Test
	void leaveDuringPendingJoinStillEvicts() throws Exception {
		CountDownLatch checked = new CountDownLatch(1);
		CountDownLatch release = new CountDownLatch(1);
		Thread join = Thread.ofVirtual().start(() -> hub.joinRoom("r", session("u"), () -> {
			checked.countDown(); // membership check passed; leave commits right after
			await(release);
			return "state";
		}));
		assertThat(checked.await(5, TimeUnit.SECONDS)).isTrue();

		Thread leave = Thread.ofVirtual().start(() -> hub.removeFromRoom("r", "u"));
		leave.join(200);
		assertThat(leave.isAlive()).as("eviction waits for the pending join").isTrue();

		release.countDown();
		join.join(5000);
		leave.join(5000);
		assertThat(hub.presentIn("r")).isEmpty();
	}

	@Test
	void failedCheckRegistersNothing() {
		assertThatThrownBy(() -> hub.joinRoom("r", session("u"), () -> {
			throw new IllegalStateException("not a member");
		})).isInstanceOf(IllegalStateException.class);
		assertThat(hub.presentIn("r")).isEmpty();

		assertThat(hub.<String>joinRoom("r", session("v"), () -> "ok")).isEqualTo("ok");
		assertThat(hub.presentIn("r")).containsExactly("v");
	}

	private static void await(CountDownLatch latch) {
		try {
			latch.await(5, TimeUnit.SECONDS);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}
}
