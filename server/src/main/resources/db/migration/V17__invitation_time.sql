-- Invitations count for 30 seconds (decision 87): when each was made. Existing ones count as expired.
ALTER TABLE room_invitations ADD COLUMN invited_at BIGINT NOT NULL DEFAULT 0;
