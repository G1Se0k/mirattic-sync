package com.mirattic.sync.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

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

	record RefreshRequest(@NotBlank @Size(max = 128) String refreshToken) {
	}

	private final AuthService auth;

	AuthController(AuthService auth) {
		this.auth = auth;
	}

	@PostMapping("/signup")
	@ResponseStatus(HttpStatus.CREATED)
	AuthService.Tokens signup(@Valid @RequestBody SignupRequest req) {
		return auth.signup(req.email(), req.password(), req.displayName());
	}

	@PostMapping("/login")
	AuthService.Tokens login(@Valid @RequestBody LoginRequest req) {
		return auth.login(req.email(), req.password());
	}

	@PostMapping("/refresh")
	AuthService.Tokens refresh(@Valid @RequestBody RefreshRequest req) {
		return auth.refresh(req.refreshToken());
	}

	@PostMapping("/logout")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void logout(@Valid @RequestBody RefreshRequest req) {
		auth.logout(req.refreshToken());
	}
}
