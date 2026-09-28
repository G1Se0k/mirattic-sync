-- Room side chat. Deleted with the room; mediaPositionMs is where the sender's player was.
CREATE TABLE chat_messages (
    id                 VARCHAR(36)   NOT NULL PRIMARY KEY,
    room_id            VARCHAR(36)   NOT NULL,
    user_id            VARCHAR(36)   NOT NULL,
    text               VARCHAR(1000) NOT NULL,
    media_position_ms  BIGINT        NULL,
    created_at         BIGINT        NOT NULL,
    CONSTRAINT fk_chat_messages_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_messages_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_chat_messages_room (room_id, created_at)
);
