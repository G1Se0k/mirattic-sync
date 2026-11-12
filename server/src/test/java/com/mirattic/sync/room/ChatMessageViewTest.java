package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class ChatMessageViewTest {

	@Test
	void oneNoLongerKnownIsASpanWithoutAnId() {
		String text = ChatMessage.MARK + "0" + ChatMessage.MARK + " and " + ChatMessage.MARK + "1" + ChatMessage.MARK;
		var view = new ChatMessage.View("m", "r", "u", text, null, null, 0, false, null, "U", List.of("a", "gone"), null)
				.shown(id -> id.equals("a") ? "Ann" : null);
		assertThat(view.text()).isEqualTo("@Ann and @알 수 없음");
		assertThat(view.mentionSpans()).containsExactly(new ChatMessage.Span("a", 0, 4), new ChatMessage.Span(null, 9, 16));
	}
}
