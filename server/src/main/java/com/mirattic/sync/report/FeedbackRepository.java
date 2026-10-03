package com.mirattic.sync.report;

import org.springframework.data.jpa.repository.JpaRepository;

interface FeedbackRepository extends JpaRepository<Feedback, String> {

	long countByUserIdAndCreatedAtGreaterThan(String userId, long since);
}
