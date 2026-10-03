-- The video a chat line's timestamp belongs to ("<provider>:<contentId>", the room's then): a timestamp moves
-- playback only while the room still shows that video. Never shown; NULL for lines without a position (and older ones).
ALTER TABLE chat_messages ADD COLUMN content_key VARCHAR(529) NULL; -- provider (16) + ":" + content_id (512)
