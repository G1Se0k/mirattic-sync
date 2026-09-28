package com.mirattic.sync.room;

import java.util.List;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

interface ChatMessageRepository extends JpaRepository<ChatMessage, String> {

	List<ChatMessage> findByRoomIdOrderByCreatedAtDescIdDesc(String roomId, Limit limit);

	/** The page before (createdAt, id): messages in the same millisecond are ordered by id, so none is skipped. */
	@Query("""
			select m from ChatMessage m where m.roomId = :roomId
			and (m.createdAt < :createdAt or (m.createdAt = :createdAt and m.id < :id))
			order by m.createdAt desc, m.id desc""")
	List<ChatMessage> findBefore(String roomId, long createdAt, String id, Limit limit);

	long countByRoomIdAndUserIdNotAndReactionFalseAndCreatedAtGreaterThan(String roomId, String userId, long after);
}
