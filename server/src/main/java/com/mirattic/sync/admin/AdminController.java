package com.mirattic.sync.admin;

import com.mirattic.sync.account.AccountController;
import com.mirattic.sync.auth.MiratticAuth;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Sync data for the Mirattic admin console (Auth docs/admin.md): Auth reads it with a one-minute order it signs, aud =
 * mirattic-sync, purpose = admin_read. Read-only. Counts and what operators read anyway (reports, feedback); never chat
 * messages themselves. Answers `{"facts": [[label, value]], "tables": [{title, columns, rows}]}`.
 */
@RestController
public class AdminController {

	public static final String PATH = "/api/internal/admin";

	private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yy.M.d HH:mm")
			.withZone(ZoneId.of("Asia/Seoul"));
	private static final long DAY = 86_400_000L;
	private static final int PAGE = 50;

	private final JwtDecoder orders;
	private final JdbcTemplate jdbc;

	AdminController(MiratticAuth auth, JdbcTemplate jdbc) {
		this.orders = auth.decoder(AccountController.order("admin_read"));
		this.jdbc = jdbc;
	}

	@GetMapping(PATH + "/stats")
	ResponseEntity<Map<String, Object>> stats(
			@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
		if (!authorized(authorization)) {
			return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
		}
		long now = System.currentTimeMillis();
		List<List<String>> facts = List.of(
				fact("Sync 프로필", count("SELECT COUNT(*) FROM users")),
				fact("7일 내 가입", count("SELECT COUNT(*) FROM users WHERE created_at >= ?", now - 7 * DAY)),
				fact("친구 관계", count("SELECT COUNT(*) FROM friendships WHERE status = 'ACCEPTED'")),
				fact("열린 방 / 참여 중", count("SELECT COUNT(*) FROM rooms") + " / " + count("SELECT COUNT(*) FROM room_members")),
				fact("24시간 채팅 수", count("SELECT COUNT(*) FROM chat_messages WHERE created_at >= ?", now - DAY)));
		return ResponseEntity.ok(Map.of("facts", facts, "tables", List.of(
				table("최근 신고", List.of("시각", "사유", "내용", "대상 UID"), """
						SELECT created_at, reason, COALESCE(detail, ''), target_user_id FROM reports
						ORDER BY created_at DESC LIMIT 5"""),
				table("최근 피드백", List.of("시각", "종류", "내용", "UID"), """
						SELECT created_at, kind, text, user_id FROM feedback ORDER BY created_at DESC LIMIT 5"""))));
	}

	@GetMapping(PATH + "/users/{uid}")
	ResponseEntity<Map<String, Object>> user(@PathVariable String uid,
			@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
		if (!authorized(authorization)) {
			return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
		}
		List<Map<String, Object>> found = jdbc.queryForList("SELECT display_name, friend_code, presence_visibility, "
				+ "created_at FROM users WHERE id = ?", uid);
		if (found.isEmpty()) {
			return ResponseEntity.ok(Map.of("facts", List.of(fact("Sync 프로필", "없음")), "tables", List.of()));
		}
		Map<String, Object> u = found.getFirst();
		List<List<String>> facts = List.of(
				fact("Sync 이름", String.valueOf(u.get("display_name"))),
				fact("친구 코드", String.valueOf(u.get("friend_code"))),
				fact("접속 상태 공개", String.valueOf(u.get("presence_visibility"))),
				fact("Sync 가입", TIME.format(Instant.ofEpochMilli(((Number) u.get("created_at")).longValue()))),
				fact("친구", count("SELECT COUNT(*) FROM friendships WHERE status = 'ACCEPTED' AND (requester_id = ? "
						+ "OR addressee_id = ?)", uid, uid)),
				fact("보낸 채팅", count("SELECT COUNT(*) FROM chat_messages WHERE user_id = ?", uid)),
				fact("신고함 / 신고당함", count("SELECT COUNT(*) FROM reports WHERE reporter_id = ?", uid) + " / "
						+ count("SELECT COUNT(*) FROM reports WHERE target_user_id = ?", uid)));
		return ResponseEntity.ok(Map.of("facts", facts, "tables", List.of(
				// Not what the room is watching: the admin sees that it is in one, not its viewing.
				table("참여 중인 방", List.of("입장", "역할", "인원"), """
						SELECT m.joined_at, m.role, (SELECT COUNT(*) FROM room_members o WHERE o.room_id = m.room_id)
						FROM room_members m WHERE m.user_id = ? ORDER BY m.joined_at DESC LIMIT 20""", uid),
				table("받은 신고", List.of("시각", "사유", "내용"), """
						SELECT created_at, reason, COALESCE(detail, '') FROM reports WHERE target_user_id = ?
						ORDER BY created_at DESC LIMIT 20""", uid),
				table("피드백", List.of("시각", "종류", "내용"), """
						SELECT created_at, kind, text FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 20""",
						uid))));
	}

	/** Every report, newest first, with the reported message as copied at the time. 50 per page. */
	@GetMapping(PATH + "/reports")
	ResponseEntity<Map<String, Object>> reports(@RequestParam(defaultValue = "0") int page,
			@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
		if (!authorized(authorization)) {
			return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
		}
		return page("신고", count("SELECT COUNT(*) FROM reports"), page, table("신고", List.of("시각", "사유", "내용",
				"신고된 메시지", "신고한 사람", "신고자 UID", "대상", "대상 UID"), """
				SELECT r.created_at, r.reason, COALESCE(r.detail, ''), COALESCE(r.message_text, ''),
				  COALESCE(a.display_name, ''), r.reporter_id, COALESCE(t.display_name, ''), r.target_user_id
				FROM reports r LEFT JOIN users a ON a.id = r.reporter_id LEFT JOIN users t ON t.id = r.target_user_id
				ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?""", PAGE + 1, (long) Math.max(page, 0) * PAGE)); // long: a huge page is empty, not an overflow
	}

	/** Every feedback / bug report from Settings, newest first. 50 per page. */
	@GetMapping(PATH + "/feedback")
	ResponseEntity<Map<String, Object>> feedback(@RequestParam(defaultValue = "0") int page,
			@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
		if (!authorized(authorization)) {
			return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
		}
		return page("피드백 · 버그 리포트", count("SELECT COUNT(*) FROM feedback"), page, table("피드백 · 버그 리포트",
				List.of("시각", "종류", "내용", "보낸 사람", "UID"), """
				SELECT f.created_at, CASE f.kind WHEN 'BUG' THEN '버그' ELSE '피드백' END, f.text,
				  COALESCE(u.display_name, ''), f.user_id
				FROM feedback f LEFT JOIN users u ON u.id = f.user_id
				ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?""", PAGE + 1, (long) Math.max(page, 0) * PAGE)); // long: a huge page is empty, not an overflow
	}

	/** One page of a list fetched with PAGE + 1 rows: the extra row only says there is a next page. */
	@SuppressWarnings("unchecked")
	private static ResponseEntity<Map<String, Object>> page(String what, String total, int page,
			Map<String, Object> table) {
		List<List<String>> rows = (List<List<String>>) table.get("rows");
		boolean more = rows.size() > PAGE;
		Map<String, Object> shown = Map.of("title", table.get("title"), "columns", table.get("columns"),
				"rows", rows.subList(0, Math.min(rows.size(), PAGE)));
		return ResponseEntity.ok(Map.of("facts", List.of(fact("전체 " + what, total)), "tables", List.of(shown),
				"more", more));
	}

	private boolean authorized(String authorization) {
		try {
			return authorization != null && authorization.regionMatches(true, 0, "Bearer ", 0, 7)
					&& orders.decode(authorization.substring(7)) != null;
		} catch (JwtException e) {
			return false;
		}
	}

	private String count(String sql, Object... args) {
		return String.valueOf(jdbc.queryForObject(sql, Long.class, args));
	}

	private static List<String> fact(String label, String value) {
		return List.of(label, value);
	}

	/** The first column is an epoch-millis time. */
	private Map<String, Object> table(String title, List<String> columns, String sql, Object... args) {
		List<List<String>> rows = jdbc.query(sql, (rs, n) -> {
			List<String> row = new ArrayList<>();
			row.add(TIME.format(Instant.ofEpochMilli(rs.getLong(1))));
			for (int i = 2; i <= columns.size(); i++) {
				row.add(rs.getString(i));
			}
			return row;
		}, args);
		return Map.of("title", title, "columns", columns, "rows", rows);
	}
}
