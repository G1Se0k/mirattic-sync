package com.mirattic.sync.auth;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Expiring single-use entries, capped so unauthenticated /auth/start calls can't fill the heap.
 * ponytail: in memory, so a restart drops logins in progress (they retry) and one instance only.
 */
final class ShortLived<V> {

	private record Entry<V>(V value, long expiresAt) {
	}

	private static final int MAX = 10_000;
	private final Map<String, Entry<V>> map = new ConcurrentHashMap<>();
	private final long ttlMillis;

	ShortLived(Duration ttl) {
		this.ttlMillis = ttl.toMillis();
	}

	void put(String key, V value) {
		long now = System.currentTimeMillis();
		if (map.size() >= MAX) {
			map.values().removeIf(e -> e.expiresAt() <= now);
			if (map.size() >= MAX) {
				throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "too many logins in progress");
			}
		}
		map.put(key, new Entry<>(value, now + ttlMillis));
	}

	V take(String key) {
		Entry<V> e = map.remove(key);
		return e == null || e.expiresAt() <= System.currentTimeMillis() ? null : e.value();
	}
}
