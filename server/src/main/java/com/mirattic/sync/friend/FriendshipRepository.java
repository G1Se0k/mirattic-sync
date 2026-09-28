package com.mirattic.sync.friend;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface FriendshipRepository extends JpaRepository<Friendship, String> {

	@Query("""
			select case when f.requesterId = :userId then f.addresseeId else f.requesterId end
			from Friendship f
			where (f.requesterId = :userId or f.addresseeId = :userId)
			  and f.status = com.mirattic.sync.friend.Friendship.Status.ACCEPTED""")
	List<String> friendIds(String userId);

	/** Everyone with a friendship or a pending request with `userId`, either direction. */
	@Query("""
			select case when f.requesterId = :userId then f.addresseeId else f.requesterId end
			from Friendship f
			where f.requesterId = :userId or f.addresseeId = :userId""")
	List<String> contactIds(String userId);

	@Query("""
			select f from Friendship f
			where (f.requesterId = :a and f.addresseeId = :b) or (f.requesterId = :b and f.addresseeId = :a)""")
	Optional<Friendship> findPair(String a, String b);

	/**
	 * The accepted friendships between `userId` and `others`, share-locked until the transaction ends: a block
	 * (which deletes the friendship) waits, so it can't slip between checking a friendship and relying on it.
	 */
	@Lock(LockModeType.PESSIMISTIC_READ)
	@Query("""
			select f from Friendship f
			where f.status = com.mirattic.sync.friend.Friendship.Status.ACCEPTED
			  and ((f.requesterId = :userId and f.addresseeId in :others)
			    or (f.addresseeId = :userId and f.requesterId in :others))""")
	List<Friendship> lockFriendships(String userId, Collection<String> others);

	List<Friendship> findByAddresseeIdAndStatus(String addresseeId, Friendship.Status status);

	List<Friendship> findByRequesterIdAndStatus(String requesterId, Friendship.Status status);
}
