package com.mirattic.sync.ws;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import org.springframework.web.util.UriComponentsBuilder;

@Configuration
@EnableWebSocket
class WebSocketConfig implements WebSocketConfigurer {

	private final SocketHandler handler;
	private final TicketService tickets;
	private final List<String> allowedOrigins;

	WebSocketConfig(SocketHandler handler, TicketService tickets,
			@Value("${app.allowed-origins}") List<String> allowedOrigins) {
		this.handler = handler;
		this.tickets = tickets;
		this.allowedOrigins = allowedOrigins;
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		registry.addHandler(handler, "/ws")
				.addInterceptors(new TicketInterceptor())
				.setAllowedOrigins(allowedOrigins.toArray(String[]::new));
	}

	/** Caps inbound frame size; events are small JSON. */
	@Bean
	ServletServerContainerFactoryBean webSocketContainer() {
		ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
		container.setMaxTextMessageBufferSize(16 * 1024);
		container.setMaxBinaryMessageBufferSize(1024);
		return container;
	}

	private class TicketInterceptor implements HandshakeInterceptor {
		@Override
		public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
				WebSocketHandler wsHandler, Map<String, Object> attributes) {
			String ticket = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams().getFirst("ticket");
			String userId = tickets.consume(ticket);
			if (userId == null) {
				response.setStatusCode(HttpStatus.UNAUTHORIZED);
				return false;
			}
			attributes.put(SocketHandler.USER_ID, userId);
			return true;
		}

		@Override
		public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
				WebSocketHandler wsHandler, Exception exception) {
		}
	}
}
