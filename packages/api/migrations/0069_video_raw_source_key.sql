-- Original uploaded file staged for progressive playback while the encode
-- pipeline produces HLS. Cleared once fully_processed arrives.
ALTER TABLE videos ADD COLUMN raw_source_key TEXT;
