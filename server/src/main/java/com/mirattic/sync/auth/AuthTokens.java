package com.mirattic.sync.auth;

import com.mirattic.sync.user.UserSummary;

/** Mirattic Auth access and refresh token as handed to the extension, with the Sync user they belong to. */
public record AuthTokens(String accessToken, String refreshToken, UserSummary user) {
}
