-- Mentions kept by user ID in the text (decision 122): the ID between two U+E000 marks where "@name" was, shown with the name now.
-- Room for the IDs: a message is still at most 1000 characters as written, at most 4000 stored.
ALTER TABLE chat_messages MODIFY text VARCHAR(4000) NOT NULL;
-- A reported message is kept as shown then: with names now, it can be longer than as written.
ALTER TABLE reports MODIFY message_text VARCHAR(4000) NULL;
