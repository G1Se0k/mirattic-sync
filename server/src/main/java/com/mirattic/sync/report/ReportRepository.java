package com.mirattic.sync.report;

import org.springframework.data.jpa.repository.JpaRepository;

interface ReportRepository extends JpaRepository<Report, String> {

	long countByReporterIdAndCreatedAtGreaterThan(String reporterId, long since);

	boolean existsByReporterIdAndMessageId(String reporterId, String messageId);
}
