package com.mirattic.sync.report;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

/** A report for operators to review. A reported message is copied, so it stays readable if deleted. */
@Entity
@Table(name = "reports")
class Report {

	enum Reason {
		SPAM, HARASSMENT, INAPPROPRIATE, OTHER
	}

	@Id
	private String id;
	private String reporterId;
	private String targetUserId;
	@Enumerated(EnumType.STRING)
	private Reason reason;
	private String detail;
	private String messageId;
	private String roomId;
	private String messageText;
	private long createdAt;

	protected Report() {
	}

	Report(String reporterId, String targetUserId, Reason reason, String detail, String messageId, String roomId,
			String messageText) {
		this.id = UUID.randomUUID().toString();
		this.reporterId = reporterId;
		this.targetUserId = targetUserId;
		this.reason = reason;
		this.detail = detail;
		this.messageId = messageId;
		this.roomId = roomId;
		this.messageText = messageText;
		this.createdAt = System.currentTimeMillis();
	}

	String getId() { return id; }
}
