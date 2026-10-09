package com.mirattic.sync.friend;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface BlockRepository extends JpaRepository<Block, Block.Key> {

	@Query("""
			select count(b) > 0 from Block b
			where (b.blockerId = :a and b.blockedId = :b) or (b.blockerId = :b and b.blockedId = :a)""")
	boolean existsBetween(String a, String b);

	/** Blocks either way between `me` and any of `others`, share-locked to the end of the transaction. */
	@Lock(LockModeType.PESSIMISTIC_READ)
	@Query("""
			select b from Block b
			where (b.blockerId = :me and b.blockedId in :others) or (b.blockedId = :me and b.blockerId in :others)""")
	List<Block> lockBetween(String me, Collection<String> others);

	List<Block> findByBlockerId(String blockerId);

	/** Everyone `me` blocks or is blocked by. */
	@Query("""
			select case when b.blockerId = :me then b.blockedId else b.blockerId end from Block b
			where b.blockerId = :me or b.blockedId = :me""")
	List<String> othersOf(String me);
}
