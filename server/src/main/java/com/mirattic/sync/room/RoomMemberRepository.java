package com.mirattic.sync.room;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface RoomMemberRepository extends JpaRepository<RoomMember, RoomMember.Key> {

	List<RoomMember> findByRoomId(String roomId);

	List<RoomMember> findByRoomIdIn(Collection<String> roomIds);

	List<RoomMember> findByUserId(String userId);

	Optional<RoomMember> findByRoomIdAndUserId(String roomId, String userId);

	/** Raises the seen room type version, never lowers it (one statement: confirmations racing can't undo each other). */
	@Modifying(flushAutomatically = true, clearAutomatically = true)
	@Query("update RoomMember m set m.typeSeenVersion = :version"
			+ " where m.roomId = :roomId and m.userId = :userId and m.typeSeenVersion < :version")
	int seeType(@Param("roomId") String roomId, @Param("userId") String userId, @Param("version") long version);
}
