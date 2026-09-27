-- Users are identified only by their own UID (users.id). Ways to sign in live in user_identities,
-- so OAuth providers can be attached later as extra rows on the same user.
CREATE TABLE user_identities (
    id             VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id        VARCHAR(36)  NOT NULL,
    -- LOCAL = email + password. OAuth providers (GOOGLE, APPLE, ...) are added when implemented.
    provider       VARCHAR(16)  NOT NULL,
    -- LOCAL: normalized email. OAuth: the provider's stable subject id (never the email).
    subject        VARCHAR(255) NOT NULL,
    -- Contact email reported by the identity; used for friend search. May be null for OAuth.
    email          VARCHAR(254) NULL,
    -- LOCAL only.
    password_hash  VARCHAR(100) NULL,
    created_at     BIGINT       NOT NULL,
    CONSTRAINT uk_user_identities_provider_subject UNIQUE (provider, subject),
    CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_user_identities_user (user_id),
    INDEX idx_user_identities_email (email)
);

INSERT INTO user_identities (id, user_id, provider, subject, email, password_hash, created_at)
SELECT UUID(), id, 'LOCAL', email, email, password_hash, created_at FROM users;

ALTER TABLE users DROP COLUMN email, DROP COLUMN password_hash;
