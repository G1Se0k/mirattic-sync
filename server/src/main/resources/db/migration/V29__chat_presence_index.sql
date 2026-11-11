-- A member's latest join / leave line in a room (RoomService.loggedIn, after a server restart): found by index.
CREATE INDEX idx_chat_messages_presence ON chat_messages (room_id, user_id, kind, seq);
