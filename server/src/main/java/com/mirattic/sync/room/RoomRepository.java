package com.mirattic.sync.room;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

interface RoomRepository extends JpaRepository<Room, String> {

	/** Serializes playback commands per room so versions are assigned in commit order. */
	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select r from Room r where r.id = :id")
	Optional<Room> findForUpdate(String id);

	Optional<Room> findByCode(String code);

	/** Locked from the first read, so the member count and blocks checked after it are current. */
	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select r from Room r where r.code = :code")
	Optional<Room> findByCodeForUpdate(String code);
}
