-- Unread by a per-message sequence instead of time: a read mark and a message in the same millisecond
-- were indistinguishable. Messages are inserted and read marks taken under the room's row lock, so every
-- message is either at or below a mark (seen) or above it (unread).

-- Existing messages are numbered in time order (id breaks ties, as history pages them), then new ones
-- continue from the highest.
ALTER TABLE chat_messages ADD COLUMN seq BIGINT NULL;
UPDATE chat_messages m
    JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM chat_messages) o ON o.id = m.id
SET m.seq = o.n;
ALTER TABLE chat_messages MODIFY seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE;

-- V7's read marks carry over: what was read by time stays read.
ALTER TABLE room_members ADD COLUMN last_read_seq BIGINT NOT NULL DEFAULT 0;
UPDATE room_members rm
SET last_read_seq = COALESCE((SELECT MAX(m.seq) FROM chat_messages m
                              WHERE m.room_id = rm.room_id AND m.created_at <= rm.last_read_at), 0);
ALTER TABLE room_members DROP COLUMN last_read_at;
