CREATE TABLE users (
    id                   VARCHAR(36)  NOT NULL PRIMARY KEY,
    email                VARCHAR(254) NOT NULL,
    password_hash        VARCHAR(100) NOT NULL,
    display_name         VARCHAR(32)  NOT NULL,
    presence_visibility  VARCHAR(16)  NOT NULL,
    position_visibility  VARCHAR(16)  NOT NULL,
    created_at           BIGINT       NOT NULL,
    CONSTRAINT uk_users_email UNIQUE (email)
);

CREATE TABLE refresh_tokens (
    id          VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    family_id   VARCHAR(36) NOT NULL,
    token_hash  CHAR(64)    NOT NULL,
    expires_at  BIGINT      NOT NULL,
    revoked_at  BIGINT      NULL,
    CONSTRAINT uk_refresh_tokens_hash UNIQUE (token_hash),
    CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_refresh_tokens_family (family_id)
);

-- One row per pair regardless of direction (functional unique index on the unordered pair).
-- Self-references are rejected in FriendService (MySQL forbids CHECK on FK columns with ON DELETE CASCADE).
CREATE TABLE friendships (
    id            VARCHAR(36) NOT NULL PRIMARY KEY,
    requester_id  VARCHAR(36) NOT NULL,
    addressee_id  VARCHAR(36) NOT NULL,
    status        VARCHAR(16) NOT NULL,
    created_at    BIGINT      NOT NULL,
    CONSTRAINT fk_friendships_requester FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_friendships_addressee FOREIGN KEY (addressee_id) REFERENCES users (id) ON DELETE CASCADE,
    UNIQUE INDEX uk_friendships_pair ((LEAST(requester_id, addressee_id)), (GREATEST(requester_id, addressee_id))),
    INDEX idx_friendships_addressee (addressee_id)
);

CREATE TABLE blocks (
    blocker_id  VARCHAR(36) NOT NULL,
    blocked_id  VARCHAR(36) NOT NULL,
    created_at  BIGINT      NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT fk_blocks_blocker FOREIGN KEY (blocker_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_blocks_blocked FOREIGN KEY (blocked_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_blocks_blocked (blocked_id)
);
