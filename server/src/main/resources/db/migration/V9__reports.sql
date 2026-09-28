-- User / chat message reports, reviewed by operators. The message is copied (room, text), so deleting it
-- keeps the report readable. Both users' reports go with either account (account deletion removes everything).
CREATE TABLE reports (
    id              VARCHAR(36)   NOT NULL PRIMARY KEY,
    reporter_id     VARCHAR(36)   NOT NULL,
    target_user_id  VARCHAR(36)   NOT NULL,
    reason          VARCHAR(16)   NOT NULL,
    detail          VARCHAR(500)  NULL,
    message_id      VARCHAR(36)   NULL,
    room_id         VARCHAR(36)   NULL,
    message_text    VARCHAR(1000) NULL,
    created_at      BIGINT        NOT NULL,
    CONSTRAINT fk_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_reports_target FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT uq_reports_message UNIQUE (reporter_id, message_id),
    INDEX idx_reports_reporter (reporter_id, created_at)
);
