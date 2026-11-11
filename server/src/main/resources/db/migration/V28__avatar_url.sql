-- Auth's profile photo URL (a Mirattic Auth R2 URL, never a copy of the file); NULL = none.
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL;
