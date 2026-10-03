package com.mirattic.sync.report;

import com.mirattic.sync.user.UserRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Feedback and bug reports, kept for operators (read in the database, like reports). */
@RestController
class FeedbackController {

	/** Per user per day: enough for real use, too few to flood operators. */
	static final int MAX_PER_DAY = 10;
	private static final long DAY_MS = 24 * 60 * 60 * 1000L;
	private static final Logger log = LoggerFactory.getLogger(FeedbackController.class);

	record FeedbackRequest(@NotNull Feedback.Kind kind, @NotBlank @Size(max = 2000) String text) {
	}

	private final FeedbackRepository feedback;
	private final UserRepository users;

	FeedbackController(FeedbackRepository feedback, UserRepository users) {
		this.feedback = feedback;
		this.users = users;
	}

	@PostMapping("/api/feedback")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@Transactional
	public void send(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody FeedbackRequest body) {
		String me = jwt.getSubject();
		// One at a time per user, so the daily count can't be passed by concurrent requests.
		users.findForUpdate(me).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
		if (feedback.countByUserIdAndCreatedAtGreaterThan(me, System.currentTimeMillis() - DAY_MS) >= MAX_PER_DAY) {
			throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
		}
		Feedback saved = feedback.save(new Feedback(me, body.kind(), body.text().strip()));
		log.info("feedback {} received", saved.getId()); // id only: the text stays in the database
	}
}
