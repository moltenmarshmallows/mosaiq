-- Encode mode chosen at upload time; the ingest-retry endpoint re-sends it so
-- a retry doesn't silently fall back to fast_lane.
ALTER TABLE videos ADD COLUMN pipeline_mode TEXT;
