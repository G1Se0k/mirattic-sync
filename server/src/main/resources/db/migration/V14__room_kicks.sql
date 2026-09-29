-- Kicked from a room by its host (decision 79): can't come back by the room's code; the host's invite lifts it.
CREATE TABLE room_bans (
  room_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT fk_room_bans_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_bans_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
