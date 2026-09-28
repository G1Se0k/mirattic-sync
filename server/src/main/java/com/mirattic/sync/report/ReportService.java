package com.mirattic.sync.report;

import com.mirattic.sync.friend.Block;
import com.mirattic.sync.friend.BlockRepository;
import com.mirattic.sync.friend.FriendshipRepository;
import com.mirattic.sync.room.ChatMessage;
import com.mirattic.sync.room.RoomService;
import com.mirattic.sync.user.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Reports a chat message (`messageId`) or a user (`userId`). Only what the reporter could see is reportable:
 * a message in one of their rooms, or a friend, a user they share a room with, or one they blocked.
 * Anything else answers 404, so reports can't probe user ids.
 */
@Service
class ReportService {

	/** Per reporter per day: enough for real use, too few to flood operators. */
	static final int MAX_PER_DAY = 20;
	private static final long DAY_MS = 24 * 60 * 60 * 1000L;
	private static final Logger log = LoggerFactory.getLogger(ReportService.class);

	private final ReportRepository reports;
	private final RoomService rooms;
	private final FriendshipRepository friendships;
	private final BlockRepository blocks;
	private final UserRepository users;

	ReportService(ReportRepository reports, RoomService rooms, FriendshipRepository friendships,
			BlockRepository blocks, UserRepository users) {
		this.users = users;
		this.reports = reports;
		this.rooms = rooms;
		this.friendships = friendships;
		this.blocks = blocks;
	}

	@Transactional
	public void save(String me, ReportController.ReportRequest body) {
		if ((body.userId() == null) == (body.messageId() == null)) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "userId or messageId");
		}
		// One report at a time per reporter, so the daily count can't be passed by concurrent requests (and a
		// message can't be saved twice).
		users.findForUpdate(me).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
		String detail = body.detail() == null || body.detail().isBlank() ? null : body.detail().strip();
		Report report;
		if (body.messageId() != null) {
			ChatMessage.View m = rooms.reportable(me, body.messageId());
			if (reports.existsByReporterIdAndMessageId(me, m.id())) {
				return; // already reported
			}
			report = new Report(me, m.userId(), body.reason(), detail, m.id(), m.roomId(), m.text());
		} else {
			String target = body.userId();
			if (target.equals(me)) {
				throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cannot report yourself");
			}
			if (!friendships.friendIds(me).contains(target) && !rooms.shareARoom(me, target)
					&& !blocks.existsById(new Block.Key(me, target))) {
				throw new ResponseStatusException(HttpStatus.NOT_FOUND);
			}
			report = new Report(me, target, body.reason(), detail, null, null, null);
		}
		// Counted only for a new report: repeating one already made is still a 204.
		if (reports.countByReporterIdAndCreatedAtGreaterThan(me, System.currentTimeMillis() - DAY_MS) >= MAX_PER_DAY) {
			throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
		}
		reports.save(report);
		log.info("report {} received", report.getId()); // id only: contents stay in the database
	}
}
