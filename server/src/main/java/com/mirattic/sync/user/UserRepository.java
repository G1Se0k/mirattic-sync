package com.mirattic.sync.user;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface UserRepository extends JpaRepository<User, String> {

	Optional<User> findByFriendCode(String friendCode);

	/**
	 * Locks the user's row to the end of the transaction: serializes that user's reports (daily limit), and makes
	 * rows that reference the user (their foreign-key check) wait for an account deletion. Call it first, before
	 * any plain read fixes the REPEATABLE READ snapshot.
	 */
	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select u from User u where u.id = :id")
	Optional<User> findForUpdate(String id);
}
