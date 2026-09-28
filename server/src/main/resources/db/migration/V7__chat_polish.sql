-- Phase 8. A reaction is a chat message whose text is one of the allowed emoji: same history, order and
-- cleanup as messages. Unread = others' non-reaction messages after last_read_at (set when the member
-- joins or leaves the room live). muted: no chat notifications for this member.
ALTER TABLE chat_messages ADD COLUMN reaction BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_members
    ADD COLUMN last_read_at BIGINT  NOT NULL DEFAULT 0,
    ADD COLUMN muted        BOOLEAN NOT NULL DEFAULT FALSE;
