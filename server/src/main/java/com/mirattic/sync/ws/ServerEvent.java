package com.mirattic.sync.ws;

/** Mirrors `ServerEvent` in packages/types. userId/version/serverTime are always set by the server. */
public record ServerEvent(String type, String roomId, String userId, Long version, long serverTime, Object payload) {
}
