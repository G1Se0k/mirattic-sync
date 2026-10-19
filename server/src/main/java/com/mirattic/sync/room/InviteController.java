package com.mirattic.sync.room;

import com.mirattic.sync.config.AuthRateLimitFilter;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
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
	String page(@PathVariable String code, HttpServletRequest request) {
		RoomService.InvitePreview room = null;
		if (request.getAttribute(AuthRateLimitFilter.LIMITED) == null) {
			try {
				room = rooms.invitePreview(code);
			} catch (ResponseStatusException notFound) {
				// the generic preview
			}
		}
		if (room == null) {
			return page;
		}
		String name = room.name() != null ? room.name() : room.title();
		String title = room.hostName() + "님의 같이 보기 초대" + (name != null ? ": " + name : "");
		String about = room.provider() == null ? "아직 고른 영상이 없습니다"
				: SITES.getOrDefault(room.provider().name(), room.provider().name()) + (room.title() != null ? " · " + room.title() : "");
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
		return page.substring(0, start) + tags.strip() + page.substring(end);
	}

	@GetMapping(PREVIEW + "{code}")
	@ResponseBody
	RoomService.InvitePreview preview(@PathVariable String code) {
		return rooms.invitePreview(code);
	}
}
