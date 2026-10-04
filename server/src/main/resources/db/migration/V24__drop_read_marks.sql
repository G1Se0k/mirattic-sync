-- Unread counts and muting are gone (decision 104): read marks and the mute flag go.
ALTER TABLE room_members DROP COLUMN last_read_seq, DROP COLUMN muted;
