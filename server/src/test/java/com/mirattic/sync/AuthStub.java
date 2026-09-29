package com.mirattic.sync;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** A stand-in for Mirattic Auth's JWKS, token and revoke endpoints (JDK HTTP server, one per test JVM). */
public final class AuthStub {

	public static final String CLIENT_ID = "mirattic-sync";
	/** Has + / =: the Basic credentials must be form-encoded (RFC 6749 2.3.1). */
	public static final String CLIENT_SECRET = "test+secret/with=chars";

	private record Login(String sub, String name, String challenge, String redirectUri, Instant authTime) {
	}

	private static final RSAKey KEY;
	private static final HttpServer SERVER;
	private static final Map<String, Login> CODES = new ConcurrentHashMap<>();
	private static final Map<String, String> REFRESH = new ConcurrentHashMap<>(); // token → sub
	public static final Set<String> REVOKED = ConcurrentHashMap.newKeySet();
	/** Sending this refresh token makes the stub answer 400 invalid_request (not invalid_grant). */
	public static final String INVALID_REQUEST = "force-invalid-request";

	static {
		try {
			KEY = new RSAKeyGenerator(2048).keyID("test").generate();
			SERVER = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
			SERVER.createContext("/oauth2/jwks", ex -> send(ex, 200, new JWKSet(KEY.toPublicJWK()).toString()));
			SERVER.createContext("/oauth2/token", AuthStub::token);
			SERVER.createContext("/userinfo", ex -> {
				String bearer = String.valueOf(ex.getRequestHeaders().getFirst("Authorization"));
				try {
					String sub = SignedJWT.parse(bearer.replace("Bearer ", "")).getJWTClaimsSet().getSubject();
					send(ex, 200, "{\"sub\":\"" + sub + "\",\"email\":\"" + email(sub) + "\"}");
				} catch (java.text.ParseException e) {
					send(ex, 401, "{}");
				}
			});
			SERVER.createContext("/oauth2/revoke", ex -> {
				if (!authorized(ex)) {
					send(ex, 401, "{}");
					return;
				}
				String token = form(ex).get("token");
				REFRESH.remove(token);
				REVOKED.add(token);
				send(ex, 200, "");
			});
			SERVER.start();
		} catch (Exception e) {
			throw new IllegalStateException(e);
		}
	}

	private AuthStub() {
	}

	public static String issuer() {
		return "http://127.0.0.1:" + SERVER.getAddress().getPort();
	}

	/** What Auth would do after the user signs in: a code for this user, bound to the given PKCE challenge. */
	public static String code(String sub, String name, String challenge, String redirectUri) {
		return code(sub, name, challenge, redirectUri, Instant.now());
	}

	/** `authTime`: when the password was typed (ID token `auth_time`). */
	public static String code(String sub, String name, String challenge, String redirectUri, Instant authTime) {
		String code = UUID.randomUUID().toString();
		CODES.put(code, new Login(sub, name, challenge, redirectUri, authTime));
		return code;
	}

	/** The email UserInfo reports for a UID. */
	public static String email(String sub) {
		return sub + "@example.com";
	}

	/** An Auth-signed JWT with these claims on top of iss / exp. */
	public static String sign(Map<String, Object> claims) {
		try {
			JWTClaimsSet.Builder b = new JWTClaimsSet.Builder().issuer(issuer())
					.issueTime(new Date()).expirationTime(new Date(System.currentTimeMillis() + 900_000));
			claims.forEach(b::claim);
			SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY.getKeyID())
					.type(JOSEObjectType.JWT).build(), b.build());
			jwt.sign(new RSASSASigner(KEY));
			return jwt.serialize();
		} catch (Exception e) {
			throw new IllegalStateException(e);
		}
	}

	public static String accessToken(String sub) {
		return sign(Map.of("sub", sub, "aud", CLIENT_ID, "scope", List.of("openid", "profile", "email")));
	}

	private static void token(HttpExchange ex) throws IOException {
		if (!authorized(ex)) {
			send(ex, 401, "{\"error\":\"invalid_client\"}");
			return;
		}
		Map<String, String> f = form(ex);
		String sub;
		String name = null;
		Instant authTime = null;
		if ("authorization_code".equals(f.get("grant_type"))) {
			Login login = CODES.remove(f.get("code"));
			if (login == null || !login.redirectUri().equals(f.get("redirect_uri"))
					|| !login.challenge().equals(s256(f.get("code_verifier")))) {
				send(ex, 400, "{\"error\":\"invalid_grant\"}");
				return;
			}
			sub = login.sub();
			name = login.name();
			authTime = login.authTime();
		} else {
			if (INVALID_REQUEST.equals(f.get("refresh_token"))) {
				send(ex, 400, "{\"error\":\"invalid_request\"}");
				return;
			}
			sub = REFRESH.remove(String.valueOf(f.get("refresh_token")));
			if (sub == null) {
				send(ex, 400, "{\"error\":\"invalid_grant\"}");
				return;
			}
		}
		String refresh = (UUID.randomUUID() + UUID.randomUUID().toString()).repeat(2).replace("-", "");
		REFRESH.put(refresh, sub);
		Map<String, Object> id = new HashMap<>(Map.of("sub", sub, "aud", CLIENT_ID));
		if (name != null) {
			id.put("name", name);
		}
		if (authTime != null) {
			id.put("auth_time", authTime.getEpochSecond());
		}
		send(ex, 200, "{\"access_token\":\"" + accessToken(sub) + "\",\"refresh_token\":\"" + refresh
				+ "\",\"id_token\":\"" + sign(id) + "\",\"token_type\":\"Bearer\",\"expires_in\":899}");
	}

	private static boolean authorized(HttpExchange ex) {
		String basic = CLIENT_ID + ":" + URLEncoder.encode(CLIENT_SECRET, StandardCharsets.UTF_8);
		return ("Basic " + Base64.getEncoder().encodeToString(basic.getBytes(StandardCharsets.UTF_8)))
				.equals(ex.getRequestHeaders().getFirst("Authorization"));
	}

	private static Map<String, String> form(HttpExchange ex) throws IOException {
		Map<String, String> map = new HashMap<>();
		for (String pair : new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8).split("&")) {
			int i = pair.indexOf('=');
			if (i > 0) {
				map.put(URLDecoder.decode(pair.substring(0, i), StandardCharsets.UTF_8),
						URLDecoder.decode(pair.substring(i + 1), StandardCharsets.UTF_8));
			}
		}
		return map;
	}

	public static String s256(String verifier) {
		try {
			return Base64.getUrlEncoder().withoutPadding().encodeToString(
					MessageDigest.getInstance("SHA-256").digest(String.valueOf(verifier).getBytes(StandardCharsets.US_ASCII)));
		} catch (Exception e) {
			throw new IllegalStateException(e);
		}
	}

	private static void send(HttpExchange ex, int status, String body) throws IOException {
		byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
		ex.getResponseHeaders().set("Content-Type", "application/json");
		ex.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
		if (bytes.length > 0) {
			ex.getResponseBody().write(bytes);
		}
		ex.close();
	}
}
