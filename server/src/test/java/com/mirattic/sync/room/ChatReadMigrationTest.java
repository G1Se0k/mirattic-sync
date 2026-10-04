package com.mirattic.sync.room;

import static org.assertj.core.api.Assertions.assertThat;

import com.mirattic.sync.IntegrationTest;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.mysql.MySQLContainer;

/** V8 replaces V7's time-based read marks with sequence ones: an upgraded install keeps what was read. */
class ChatReadMigrationTest extends IntegrationTest {

	private static final String SCHEMA = "v8_upgrade";

	@Autowired
	private MySQLContainer mysql;

	@Test
	void upgradingFromV7KeepsReadMessagesRead() {
		// Root: the app's user may only use its own database, and this runs in a schema of its own.
		DriverManagerDataSource root = new DriverManagerDataSource(mysql.getJdbcUrl(), "root", mysql.getPassword());
		JdbcTemplate db = new JdbcTemplate(root);
		db.execute("DROP DATABASE IF EXISTS " + SCHEMA);
		Flyway flyway = Flyway.configure().dataSource(root).schemas(SCHEMA).createSchemas(true).target("7").load();
		flyway.migrate();

		for (String user : new String[] {"host", "reader"}) {
			db.update("INSERT INTO " + SCHEMA + ".users (id, display_name, presence_visibility, position_visibility,"
					+ " created_at, friend_code) VALUES (?, ?, 'FRIENDS', 'ROOM_ONLY', 0, ?)", user, user, user.substring(0, 4) + "0000");
		}
		db.update("INSERT INTO " + SCHEMA + ".rooms (id, provider, content_id, title, position_ms, playing, captured_at,"
				+ " playback_by, playback_version, created_at) VALUES ('r', 'mock', 'c', 't', 0, false, 0, 'host', 0, 0)");
		// Inserted out of time order (ids too), as UUIDs would be: the seq must follow time, not insertion or id.
		long[][] messages = {{300, 'a'}, {100, 'c'}, {200, 'b'}, {400, 'd'}, {200, 'e'}};
		for (long[] m : messages) {
			db.update("INSERT INTO " + SCHEMA + ".chat_messages (id, room_id, user_id, text, created_at) VALUES (?, 'r', 'host', 'x', ?)",
					String.valueOf((char) m[1]), m[0]);
		}
		// Read up to 250: the three at 100 and 200 are read, those at 300 and 400 are not.
		db.update("INSERT INTO " + SCHEMA + ".room_members (room_id, user_id, role, joined_at, last_read_at)"
				+ " VALUES ('r', 'host', 'HOST', 0, 0), ('r', 'reader', 'MEMBER', 0, 250)");

		Flyway.configure().dataSource(root).schemas(SCHEMA).target("8").load().migrate(); // read marks went in V24

		Long unread = db.queryForObject("SELECT COUNT(*) FROM " + SCHEMA + ".chat_messages m JOIN " + SCHEMA
				+ ".room_members rm ON rm.room_id = m.room_id AND rm.user_id = 'reader' WHERE m.seq > rm.last_read_seq", Long.class);
		assertThat(unread).isEqualTo(2);
		assertThat(db.queryForList("SELECT id FROM " + SCHEMA + ".chat_messages ORDER BY seq", String.class))
				.containsExactly("c", "b", "e", "a", "d");
		// New messages continue after the numbered ones.
		db.update("INSERT INTO " + SCHEMA + ".chat_messages (id, room_id, user_id, text, created_at) VALUES ('f', 'r', 'host', 'x', 500)");
		assertThat(db.queryForObject("SELECT seq FROM " + SCHEMA + ".chat_messages WHERE id = 'f'", Long.class)).isEqualTo(6);
		db.execute("DROP DATABASE " + SCHEMA);
	}
}
