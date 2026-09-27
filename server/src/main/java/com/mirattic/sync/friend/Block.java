package com.mirattic.sync.friend;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

@Entity
@Table(name = "blocks")
@IdClass(Block.Key.class)
public class Block {

	public record Key(String blockerId, String blockedId) {
	}

	@Id
	private String blockerId;
	@Id
	private String blockedId;
	private long createdAt;

	protected Block() {
	}

	Block(String blockerId, String blockedId) {
		this.blockerId = blockerId;
		this.blockedId = blockedId;
		this.createdAt = System.currentTimeMillis();
	}

	public String getBlockedId() { return blockedId; }
}
