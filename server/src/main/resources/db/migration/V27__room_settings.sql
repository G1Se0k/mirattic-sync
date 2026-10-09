-- Decisions 109–110: a room's own name, member limit (2–8, the host included) and whether the public list shows it.
-- Rooms made before keep what they had: no name (the video's title shows), 8, not public.
ALTER TABLE rooms ADD COLUMN name VARCHAR(20) NULL;
ALTER TABLE rooms ADD COLUMN member_limit INT NOT NULL DEFAULT 8;
ALTER TABLE rooms ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_rooms_public ON rooms (is_public, created_at);
