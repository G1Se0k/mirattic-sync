-- Mirattic Auth owns sign-in (Auth docs/migration.md, phase D): Sync keeps no credentials or refresh tokens.
-- users.id stays the UID (= Auth `sub`); product data is untouched.
DROP TABLE refresh_tokens;
DROP TABLE user_identities;
