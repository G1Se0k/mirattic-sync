package com.mirattic.sync.user;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserIdentityRepository extends JpaRepository<UserIdentity, String> {

	Optional<UserIdentity> findByProviderAndSubject(IdentityProvider provider, String subject);

	boolean existsByProviderAndSubject(IdentityProvider provider, String subject);

	List<UserIdentity> findByUserId(String userId);
}
