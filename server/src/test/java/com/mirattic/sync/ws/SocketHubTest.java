package com.mirattic.sync.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketMessage;
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

	@Test
	void aNewSessionReplacesTheOldOneAfterAFrameInProgress() throws Exception {
		WebSocketSession first = session("u");
		WebSocketSession second = session("u");
		assertThat(hub.add("u", first)).isTrue(); // came online

		// A frame of the first device is being handled (it holds the user's lock): the switch waits for it.
		CountDownLatch handling = new CountDownLatch(1);
		CountDownLatch done = new CountDownLatch(1);
		ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
		Future<Boolean> frame = pool.submit(() -> {
			synchronized (hub.lockFor("u")) {
				handling.countDown();
				done.await(); // until the test has seen the switch waiting (released in its finally)
				return hub.isCurrent("u", first); // still current while its frame runs
			}
		});
		assertThat(handling.await(5, TimeUnit.SECONDS)).isTrue();
		boolean[] cameOnline = {true};
		Thread connect = new Thread(() -> cameOnline[0] = hub.add("u", second)); // a platform thread: its state shows
		try {
			connect.start();
			for (int i = 0; i < 250 && connect.getState() != Thread.State.BLOCKED; i++) {
				Thread.sleep(20);
			}
			assertThat(connect.getState()).as("the switch waits for the frame in progress").isEqualTo(Thread.State.BLOCKED);
		} finally {
			done.countDown(); // never leave the frame (and so the switch) waiting
		}
		assertThat(frame.get(5, TimeUnit.SECONDS)).isTrue();
		connect.join(5000);
		assertThat(connect.isAlive()).isFalse();
		assertThat(cameOnline[0]).as("not the user's first session").isFalse();
		pool.shutdown();

		// From then on the first is not the user's: its frames are dropped, and it's told and closed.
		assertThat(hub.isCurrent("u", first)).isFalse();
		assertThat(hub.isCurrent("u", second)).isTrue();
		verify(first).sendMessage(argThat((WebSocketMessage<?> m) -> m.getPayload().toString().contains("session:replaced")));
		verify(first).close(SocketHub.REPLACED);
		assertThat(hub.isOnline("u")).isTrue();
	}

	private static void await(CountDownLatch latch) {
		try {
			latch.await(5, TimeUnit.SECONDS);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}
}
