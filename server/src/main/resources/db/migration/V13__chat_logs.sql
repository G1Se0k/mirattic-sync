-- Reactions are gone (decision 78); room logs (joins, leaves, the host's play / pause / seek / video change) are
-- chat lines with a kind, shown centered. NULL kind = a message someone wrote.
DELETE FROM chat_messages WHERE reaction = TRUE;
ALTER TABLE chat_messages DROP COLUMN reaction;
ALTER TABLE chat_messages ADD COLUMN kind VARCHAR(16) NULL;
-- When a seek line was moved to a later seek: the newer copy wins wherever both are seen.
ALTER TABLE chat_messages ADD COLUMN edited_at BIGINT NULL;
