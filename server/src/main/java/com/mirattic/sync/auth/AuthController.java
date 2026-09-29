package com.mirattic.sync.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** The extension's Mirattic Auth refresh token, relayed to Auth with Sync's client secret. */
@RestController
@RequestMapping("/api/auth")
class AuthController {

	record RefreshRequest(@NotBlank @Size(max = 512) String refreshToken) {
	}

	private final MiratticAuth auth;

	AuthController(MiratticAuth auth) {
		this.auth = auth;
	}

	@PostMapping("/refresh")
	AuthTokens refresh(@Valid @RequestBody RefreshRequest req) {
		return auth.refresh(req.refreshToken());
	}

	@PostMapping("/logout")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void logout(@Valid @RequestBody RefreshRequest req) {
		auth.revoke(req.refreshToken());
	}
}
