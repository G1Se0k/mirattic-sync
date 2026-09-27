package com.mirattic.sync.presence;

import static org.assertj.core.api.Assertions.assertThat;

import com.mirattic.sync.user.User;
import com.mirattic.sync.user.Visibility;
import org.junit.jupiter.api.Test;

class PresenceViewTest {

	private final MediaPresence watching = new MediaPresence(MediaProvider.youtube, "abc", "Title", null, null,
			null, null, "https://www.youtube.com/watch?v=abc", 1_432_000L, 3_000_000L, true, 1L);

	@Test
	void offlineRevealsNothing() {
		assertThat(PresenceService.view(user(Visibility.FRIENDS, Visibility.FRIENDS), false, watching))
				.isEqualTo(new PresenceView(PresenceView.Status.OFFLINE, null));
	}

	@Test
	void defaultsShowTitleButNotPosition() {
		PresenceView v = PresenceService.view(user(Visibility.FRIENDS, Visibility.ROOM_ONLY), true, watching);
		assertThat(v.status()).isEqualTo(PresenceView.Status.WATCHING);
		assertThat(v.media().title()).isEqualTo("Title");
		assertThat(v.media().positionMs()).isNull();
	}

	@Test
	void positionSharedOnlyWhenAllowed() {
		PresenceView v = PresenceService.view(user(Visibility.FRIENDS, Visibility.FRIENDS), true, watching);
		assertThat(v.media().positionMs()).isEqualTo(1_432_000L);
	}

	@Test
	void activitySharingOffOrRoomOnlyHidesMedia() {
		for (Visibility vis : new Visibility[] { Visibility.OFF, Visibility.ROOM_ONLY }) {
			assertThat(PresenceService.view(user(vis, Visibility.FRIENDS), true, watching))
					.isEqualTo(new PresenceView(PresenceView.Status.ONLINE, null));
		}
	}

	private static User user(Visibility presence, Visibility position) {
		User u = new User("U");
		u.setPrivacy(presence, position);
		return u;
	}
}
