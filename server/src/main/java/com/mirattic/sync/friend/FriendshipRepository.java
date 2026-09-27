package com.mirattic.sync.friend;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface FriendshipRepository extends JpaRepository<Friendship, String> {

	@Query("""
			select case when f.requesterId = :userId then f.addresseeId else f.requesterId end
			from Friendship f
			where (f.requesterId = :userId or f.addresseeId = :userId)
			  and f.status = com.mirattic.sync.friend.Friendship.Status.ACCEPTED""")
	List<String> friendIds(String userId);

	@Query("""
			select f from Friendship f
			where (f.requesterId = :a and f.addresseeId = :b) or (f.requesterId = :b and f.addresseeId = :a)""")
	Optional<Friendship> findPair(String a, String b);

	List<Friendship> findByAddresseeIdAndStatus(String addresseeId, Friendship.Status status);

	List<Friendship> findByRequesterIdAndStatus(String requesterId, Friendship.Status status);
}
