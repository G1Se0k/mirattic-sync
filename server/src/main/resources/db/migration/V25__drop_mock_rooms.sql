-- The test-only "mock" provider is gone (no client ever played it): the enum can no longer read it.
-- A room only typed "mock" (the type could be set apart from the video) keeps everything: its type becomes its
-- video's site, or none without a video. A room whose video is "mock" can't be shown any more: it goes.
UPDATE rooms SET room_type = provider WHERE room_type = 'mock' AND provider IS NOT NULL AND provider <> 'mock';
UPDATE rooms SET room_type = NULL WHERE room_type = 'mock' AND provider IS NULL;
DELETE FROM rooms WHERE provider = 'mock';
