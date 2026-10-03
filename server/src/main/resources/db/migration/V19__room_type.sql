-- The room's type: the site the host picked, or its video's (decision 93). NULL: none yet. Its version rises with
-- every change; a member is asked about it while their seen version (below) is lower.
ALTER TABLE rooms ADD COLUMN room_type VARCHAR(16) NULL;
ALTER TABLE rooms ADD COLUMN room_type_version BIGINT NOT NULL DEFAULT 0;
UPDATE rooms SET room_type = provider;
-- The room type version each member has seen (confirmed, or joined at): a higher room version asks them again.
ALTER TABLE room_members ADD COLUMN type_seen_version BIGINT NOT NULL DEFAULT 0;
