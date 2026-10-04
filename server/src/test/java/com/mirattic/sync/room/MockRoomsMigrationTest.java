package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;

import com.mirattic.sync.IntegrationTest;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.mysql.MySQLContainer;

/** V25 drops the "mock" provider: a room only typed "mock" keeps everything, one playing a mock video goes. */
class MockRoomsMigrationTest extends IntegrationTest {

	private static final String SCHEMA = "v25_upgrade";

	@Autowired
	private MySQLContainer mysql;

	@Test
	void onlyRoomsPlayingAMockVideoGo() {
		DriverManagerDataSource root = new DriverManagerDataSource(mysql.getJdbcUrl(), "root", mysql.getPassword());
		JdbcTemplate db = new JdbcTemplate(root);
		db.execute("DROP DATABASE IF EXISTS " + SCHEMA);
		Flyway.configure().dataSource(root).schemas(SCHEMA).createSchemas(true).target("24").load().migrate();

		String insert = "INSERT INTO " + SCHEMA + ".rooms (id, provider, content_id, title, room_type, code, position_ms,"
				+ " playing, captured_at, playback_by, playback_version, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, false, 0, 'h', 0, 0)";
		db.update(insert, "typed", "youtube", "dQw4w9WgXcQ", "t", "mock", "AAAAAAAA");
		db.update(insert, "empty", null, null, null, "mock", "BBBBBBBB");
		db.update(insert, "played", "mock", "c1", "t", "mock", "CCCCCCCC");
		db.update(insert, "fine", "laftel", "1/2", "t", "laftel", "DDDDDDDD");

		Flyway.configure().dataSource(root).schemas(SCHEMA).target("25").load().migrate();

		assertThat(db.queryForList("SELECT CONCAT(id, '=', COALESCE(room_type, '-')) FROM " + SCHEMA + ".rooms ORDER BY id",
				String.class)).containsExactly("empty=-", "fine=laftel", "typed=youtube");
		db.execute("DROP DATABASE " + SCHEMA);
	}
}
