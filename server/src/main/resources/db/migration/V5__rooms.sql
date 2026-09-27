-- Private watch rooms. The row holds the latest authoritative playback state (host-only writes);
-- playback_version only grows, so clients can drop late messages.
CREATE TABLE rooms (
    id                VARCHAR(36)   NOT NULL PRIMARY KEY,
    provider          VARCHAR(16)   NOT NULL,
    content_id        VARCHAR(512)  NOT NULL,
    title             VARCHAR(300)  NOT NULL,
    duration_ms       BIGINT        NULL,
    canonical_url     VARCHAR(2048) NULL,
    position_ms       BIGINT        NOT NULL,
    playing           BOOLEAN       NOT NULL,
    captured_at       BIGINT        NOT NULL,
    playback_by       VARCHAR(36)   NOT NULL,
    playback_version  BIGINT        NOT NULL,
    created_at        BIGINT        NOT NULL
);

CREATE TABLE room_members (
    room_id    VARCHAR(36) NOT NULL,
    user_id    VARCHAR(36) NOT NULL,
    role       VARCHAR(16) NOT NULL,
    joined_at  BIGINT      NOT NULL,
    PRIMARY KEY (room_id, user_id),
    CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
    CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_room_members_user (user_id)
);
