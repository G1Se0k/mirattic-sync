package com.mirattic.sync.user;

public record UserSummary(String id, String displayName, String avatarUrl) {

	public static UserSummary of(User u) {
		return new UserSummary(u.getId(), u.getDisplayName(), u.getAvatarUrl());
	}
}
