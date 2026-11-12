package com.mirattic.sync.room;

import com.mirattic.sync.config.AuthRateLimitFilter;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.springframework.web.util.HtmlUtils;

/**
 * Invitation links (decision 113): `/r/{code}` is the page, which reads the room from `/api/invite/{code}` and hands
 * the code to the extension. Both open without signing in and are rate limited per IP (AuthRateLimitFilter). The page
 * carries the room in its link preview tags (chat apps don't run its script): title, video and host, not the members;
 * past the limit, or for no such room, the generic preview, so the page itself tells nothing more than the API.
 */
@Controller
class InviteController {

	static final String PREVIEW = "/api/invite/";
	private static final String TAGS_START = "<!-- link preview:";
	private static final String TAGS_END = "<!-- /link preview -->";
	private static final Map<String, String> SITES = Map.of("youtube", "YouTube", "netflix", "Netflix", "laftel", "Laftel");

	private final RoomService rooms;
	private final String page;

	InviteController(RoomService rooms) throws IOException {
		this.rooms = rooms;
		this.page = new ClassPathResource("static/invite.html").getContentAsString(StandardCharsets.UTF_8);
	}

	@GetMapping(value = "/r/{code}", produces = MediaType.TEXT_HTML_VALUE)
	@ResponseBody
	ResponseEntity<String> page(@PathVariable String code, HttpServletRequest request) {
		// The preview in the language asked (decision 124): the app fetching the link says which, if any.
		Words words = Words.of(request.getHeader(HttpHeaders.ACCEPT_LANGUAGE));
		RoomService.InvitePreview room = null;
		if (request.getAttribute(AuthRateLimitFilter.LIMITED) == null) {
			try {
				room = rooms.invitePreview(code);
			} catch (ResponseStatusException notFound) {
				// the generic preview
			}
		}
		String title = words.generic;
		String about = words.about;
		if (room != null) {
			String name = room.name() != null ? room.name() : room.title();
			title = words.invite.formatted(room.hostName()) + (name != null ? ": " + name : "");
			about = room.provider() == null ? words.noVideo
					: SITES.getOrDefault(room.provider().name(), room.provider().name()) + (room.title() != null ? " · " + room.title() : "");
		}
		String base = ServletUriComponentsBuilder.fromCurrentContextPath().build().toUriString();
		String tags = """
				<meta property="og:site_name" content="Mirattic Sync">
				<meta property="og:title" content="%s">
				<meta property="og:description" content="%s">
				<meta property="og:image" content="%s/landing/logo.png">
				<meta name="twitter:card" content="summary">
				<meta name="theme-color" content="#2563eb">
				""".formatted(HtmlUtils.htmlEscape(title, "UTF-8"), HtmlUtils.htmlEscape(about, "UTF-8"), base);
		int start = page.indexOf(TAGS_START);
		int end = page.indexOf(TAGS_END) + TAGS_END.length();
		return ResponseEntity.ok().header(HttpHeaders.VARY, HttpHeaders.ACCEPT_LANGUAGE).contentType(MediaType.TEXT_HTML)
				.body(page.substring(0, start) + tags.strip() + page.substring(end));
	}

	/** The preview's words: Korean when no language is asked, Korean or Japanese when asked first, else English. */
	record Words(String generic, String about, String invite, String noVideo) {
		static final Words KO = new Words("Mirattic Sync 같이 보기 초대", "링크를 열고 수락하면 같은 영상을 같은 순간에 함께 봅니다.",
				"%s님의 같이 보기 초대", "아직 고른 영상이 없습니다");
		static final Words EN = new Words("Mirattic Sync watch-together invitation",
				"Open the link and accept to watch the same video at the same moment.", "%s invited you to watch together",
				"No video picked yet");
		static final Words JA = new Words("Mirattic Sync 一緒に見る招待", "リンクを開いて承認すると、同じ動画を同じ瞬間に一緒に見られます。",
				"%sさんから一緒に見る招待", "まだ動画が選ばれていません");

		static Words of(String acceptLanguage) {
			if (acceptLanguage == null || acceptLanguage.isBlank()) {
				return KO;
			}
			try {
				for (Locale.LanguageRange r : Locale.LanguageRange.parse(acceptLanguage)) {
					if (r.getWeight() == 0) {
						continue; // declined
					}
					String l = r.getRange().split("-")[0];
					if (l.equals("ko")) {
						return KO;
					}
					if (l.equals("ja")) {
						return JA;
					}
					if (l.equals("en")) {
						return EN;
					}
				}
			} catch (IllegalArgumentException malformed) {
				return KO;
			}
			return EN;
		}
	}

	@GetMapping(PREVIEW + "{code}")
	@ResponseBody
	RoomService.InvitePreview preview(@PathVariable String code) {
		return rooms.invitePreview(code);
	}
}
