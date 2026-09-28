-- A deleted message stays as a placeholder ("삭제된 메시지입니다"): its text is wiped, the row keeps its place.
ALTER TABLE chat_messages ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT FALSE;
