package com.mirattic.sync.config;

import static org.springframework.security.config.Customizer.withDefaults;

import com.mirattic.sync.account.AccountController;
import com.mirattic.sync.admin.AdminController;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.web.DefaultBearerTokenResolver;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration
public class SecurityConfig {

	private static final DefaultBearerTokenResolver BEARER = new DefaultBearerTokenResolver();

	// Bearer-token API (Mirattic Auth access tokens): stateless, no cookies, so CSRF does not apply.
	// /ws is authenticated by a one-time ticket in the handshake (see WebSocketConfig).
	@Bean
	SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
		return http
				.csrf(csrf -> csrf.disable())
				.cors(withDefaults())
				.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
				.authorizeHttpRequests(auth -> auth
						.requestMatchers(AccountController.DELETION_ORDER, AdminController.PATH + "/**").permitAll()
						.requestMatchers("/actuator/health", "/api/auth/**", "/auth/**", "/ws", "/privacy.html", "/", "/index.html", "/landing/**").permitAll()
						.anyRequest().authenticated())
				// Auth's orders (deletion, admin reads) are not access tokens: their controllers verify them.
				.oauth2ResourceServer(o -> o.jwt(withDefaults()).bearerTokenResolver(request ->
						AccountController.DELETION_ORDER.equals(request.getRequestURI())
								|| request.getRequestURI().startsWith(AdminController.PATH + "/") ? null : BEARER.resolve(request)))
				.build();
	}

	@Bean
	CorsConfigurationSource corsConfigurationSource(@Value("${app.allowed-origins}") List<String> origins) {
		CorsConfiguration cors = new CorsConfiguration();
		cors.setAllowedOrigins(origins);
		cors.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
		cors.setAllowedHeaders(List.of("Authorization", "Content-Type"));
		UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
		source.registerCorsConfiguration("/api/**", cors);
		return source;
	}
}
