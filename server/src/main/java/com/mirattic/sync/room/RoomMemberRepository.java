package com.mirattic.sync.room;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

interface RoomMemberRepository extends JpaRepository<RoomMember, RoomMember.Key> {

	List<RoomMember> findByRoomId(String roomId);

	List<RoomMember> findByUserId(String userId);

	Optional<RoomMember> findByRoomIdAndUserId(String roomId, String userId);
}
