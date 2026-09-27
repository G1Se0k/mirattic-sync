package com.mirattic.sync.user;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface UserIdentityRepository extends JpaRepository<UserIdentity, String> {

	Optional<UserIdentity> findByProviderAndSubject(IdentityProvider provider, String subject);

	boolean existsByProviderAndSubject(IdentityProvider provider, String subject);

	List<UserIdentity> findByUserId(String userId);

	@Query("select distinct i.userId from UserIdentity i where i.email = :email")
	List<String> findUserIdsByEmail(String email);
}
