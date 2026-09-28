-- Which series the room's content belongs to (YouTube playlist, Laftel item, a Netflix run of episodes):
-- members follow the host to the next video of the same series without being asked.
ALTER TABLE rooms ADD COLUMN series VARCHAR(128) NULL;
