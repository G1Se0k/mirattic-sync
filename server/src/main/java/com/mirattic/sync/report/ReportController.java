package com.mirattic.sync.report;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
class ReportController {

	/** Exactly one of `userId` / `messageId`. */
	record ReportRequest(@Size(max = 36) String userId, @Size(max = 36) String messageId,
			@NotNull Report.Reason reason, @Size(max = 500) String detail) {
	}

	private final ReportService reports;

	ReportController(ReportService reports) {
		this.reports = reports;
	}

	@PostMapping("/api/reports")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void report(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody ReportRequest body) {
		reports.save(jwt.getSubject(), body);
	}
}
