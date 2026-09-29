package com.mirattic.sync.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/auth")
class AuthController {

	record SignupRequest(
			@NotBlank @Email @Size(max = 254) String email,
			@NotBlank @Size(min = 8, max = 128) String password,
			@NotBlank @Size(max = 32) String displayName) {
	}

	record LoginRequest(@NotBlank @Size(max = 254) String email, @NotBlank @Size(max = 128) String password) {
	}

	/** Legacy Sync tokens are 43 characters, Mirattic Auth's 128. */
	record RefreshRequest(@NotBlank @Size(max = 512) String refreshToken) {
	}

	private final AuthService auth;
	private final MiratticAuth mirattic;
	private final boolean legacySignup;

	AuthController(AuthService auth, MiratticAuth mirattic, @Value("${app.legacy-signup}") boolean legacySignup) {
		this.auth = auth;
		this.mirattic = mirattic;
		this.legacySignup = legacySignup;
	}

	/** Off in production: new accounts are made in Mirattic Auth only (migration phase C). */
	@PostMapping("/signup")
	@ResponseStatus(HttpStatus.CREATED)
	AuthService.Tokens signup(@Valid @RequestBody SignupRequest req) {
		if (!legacySignup) {
			throw new ResponseStatusException(HttpStatus.GONE, "sign up with a Mirattic account");
		}
		return auth.signup(req.email(), req.password(), req.displayName());
	}

	@PostMapping("/login")
	AuthService.Tokens login(@Valid @RequestBody LoginRequest req) {
		return auth.login(req.email(), req.password());
	}

	@PostMapping("/refresh")
	AuthService.Tokens refresh(@Valid @RequestBody RefreshRequest req) {
		return auth.isLegacy(req.refreshToken()) ? auth.refresh(req.refreshToken()) : mirattic.refresh(req.refreshToken());
	}

	@PostMapping("/logout")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void logout(@Valid @RequestBody RefreshRequest req) {
		if (auth.isLegacy(req.refreshToken())) {
			auth.logout(req.refreshToken());
		} else {
			mirattic.revoke(req.refreshToken());
		}
	}
}
