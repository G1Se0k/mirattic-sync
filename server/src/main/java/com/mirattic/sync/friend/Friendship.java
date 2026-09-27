package com.mirattic.sync.friend;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "friendships")
public class Friendship {

	public enum Status {
		PENDING, ACCEPTED
	}

	@Id
	private String id;
	private String requesterId;
	private String addresseeId;
	@Enumerated(EnumType.STRING)
	private Status status;
	private long createdAt;

	protected Friendship() {
	}

	Friendship(String requesterId, String addresseeId) {
		this.id = UUID.randomUUID().toString();
		this.requesterId = requesterId;
		this.addresseeId = addresseeId;
		this.status = Status.PENDING;
		this.createdAt = System.currentTimeMillis();
	}

	public String getId() { return id; }
	public String getRequesterId() { return requesterId; }
	public String getAddresseeId() { return addresseeId; }
	public Status getStatus() { return status; }
	public long getCreatedAt() { return createdAt; }

	void accept() {
		this.status = Status.ACCEPTED;
	}
}
