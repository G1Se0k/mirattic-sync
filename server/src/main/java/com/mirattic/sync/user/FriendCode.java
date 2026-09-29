package com.mirattic.sync.user;

import java.security.SecureRandom;
import java.util.Locale;

/**
 * 8 random chars from 31 unambiguous symbols (~8.5e11 codes), stored without the dash.
 * ponytail: no retry on collision; the unique constraint rejects it (negligible below millions of users).
 */
public final class FriendCode {

	static final String ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
	static final int LENGTH = 8;
	private static final SecureRandom RANDOM = new SecureRandom();

	private FriendCode() {
	}

	/** Also the format of room codes (decision 77). */
	public static String generate() {
		StringBuilder sb = new StringBuilder(LENGTH);
		for (int i = 0; i < LENGTH; i++) {
			sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
		}
		return sb.toString();
	}

	/** Accepts user input like "k7qm-4xpr" or "K7QM 4XPR". Returns null if it can't be a code. */
	public static String normalize(String input) {
		String code = input.toUpperCase(Locale.ROOT).replaceAll("[\\s-]", "");
		if (code.length() != LENGTH) {
			return null;
		}
		for (char c : code.toCharArray()) {
			if (ALPHABET.indexOf(c) < 0) {
				return null;
			}
		}
		return code;
	}
}
