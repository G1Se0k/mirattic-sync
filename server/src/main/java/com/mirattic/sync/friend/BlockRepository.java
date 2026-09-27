package com.mirattic.sync.friend;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface BlockRepository extends JpaRepository<Block, Block.Key> {

	@Query("""
			select count(b) > 0 from Block b
			where (b.blockerId = :a and b.blockedId = :b) or (b.blockerId = :b and b.blockedId = :a)""")
	boolean existsBetween(String a, String b);

	List<Block> findByBlockerId(String blockerId);
}
