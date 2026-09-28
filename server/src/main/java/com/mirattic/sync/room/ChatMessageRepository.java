package com.mirattic.sync.room;

import java.util.List;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;

interface ChatMessageRepository extends JpaRepository<ChatMessage, String> {

	List<ChatMessage> findByRoomIdOrderByCreatedAtDesc(String roomId, Limit limit);
}
