-- Members a chat message mentions with "@name" (decision 118): their IDs, comma-separated; NULL for none.
ALTER TABLE chat_messages ADD COLUMN mentions VARCHAR(1100) NULL;
