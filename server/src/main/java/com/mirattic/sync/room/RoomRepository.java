package com.mirattic.sync.room;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Limit;
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

	/**
	 * Public rooms (decision 110) after (`at`, `id`) newest first (ties by id), whose name or video title contains `like`
	 * (a LIKE pattern; `%` alone: all, a room without either too).
	 */
	@Query("""
			select r from Room r where r.isPublic = true and (r.createdAt < :at or r.createdAt = :at and r.id < :id)
			and (:like = '%' or lower(r.name) like :like escape '!' or lower(r.title) like :like escape '!')
			order by r.createdAt desc, r.id desc""")
	List<Room> findPublic(long at, String id, String like, Limit limit);

	/** The rooms this user was kicked from (decision 79). */
	@Query("select r.id from Room r join r.banned b where b = :userId")
	List<String> findBannedIds(String userId);

	/** The rooms inviting this user (decision 85). */
	@Query("select r from Room r join r.invited i where key(i) = :userId")
	List<Room> findInviting(String userId);
}
