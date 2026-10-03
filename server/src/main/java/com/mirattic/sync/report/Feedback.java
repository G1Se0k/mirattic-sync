package com.mirattic.sync.report;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

/** Feedback or a bug report from Settings, for operators to read. */
@Entity
@Table(name = "feedback")
class Feedback {

	enum Kind {
		FEEDBACK, BUG
	}

	@Id
	private String id;
	private String userId;
	@Enumerated(EnumType.STRING)
	private Kind kind;
	private String text;
	private long createdAt;

	protected Feedback() {
	}

	Feedback(String userId, Kind kind, String text) {
		this.id = UUID.randomUUID().toString();
		this.userId = userId;
		this.kind = kind;
		this.text = text;
		this.createdAt = System.currentTimeMillis();
	}

	String getId() { return id; }
}
