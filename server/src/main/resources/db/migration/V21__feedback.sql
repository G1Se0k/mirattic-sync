-- Feedback and bug reports from Settings, read by operators in the database (like reports). Removed with the account.
CREATE TABLE feedback (
    id          VARCHAR(36)   NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36)   NOT NULL,
    kind        VARCHAR(16)   NOT NULL,
    text        VARCHAR(2000) NOT NULL,
    created_at  BIGINT        NOT NULL,
    CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    INDEX idx_feedback_user (user_id, created_at)
);
