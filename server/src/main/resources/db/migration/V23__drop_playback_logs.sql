-- The host's play / pause / seek are no longer room log lines (decision 103): the ones written before go.
DELETE FROM chat_messages WHERE kind IN ('play', 'pause', 'seek');

-- Per-room seq lookups (read marks' MAX(seq), unread counts, the room's last "content" line) without reading
-- every row of the room.
CREATE INDEX idx_chat_messages_room_seq ON chat_messages (room_id, seq);
