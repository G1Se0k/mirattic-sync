-- A room can start without a video (decision 92): the host's first video becomes its content.
ALTER TABLE rooms MODIFY provider VARCHAR(16) NULL;
ALTER TABLE rooms MODIFY content_id VARCHAR(512) NULL;
ALTER TABLE rooms MODIFY title VARCHAR(300) NULL;
