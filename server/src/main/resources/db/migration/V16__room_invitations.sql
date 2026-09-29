-- Invitations (decision 85): the host's invite no longer makes a member; the friend accepts (then joins) or
-- declines. Existing members stay as they are.
CREATE TABLE room_invitations (
  room_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT fk_room_invitations_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_invitations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
