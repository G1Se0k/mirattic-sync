-- The host's playback speed: members play at it, and positions are extrapolated with it.
ALTER TABLE rooms ADD COLUMN playback_rate DOUBLE NOT NULL DEFAULT 1;
