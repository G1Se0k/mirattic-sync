-- Decision 108: a user may take friend requests by their code only (not from room members by name). Off by default.
ALTER TABLE users ADD COLUMN friend_code_only BOOLEAN NOT NULL DEFAULT FALSE;
