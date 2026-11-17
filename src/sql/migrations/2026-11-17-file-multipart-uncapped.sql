-- xchain:migration mode=auto
-- Widen multipart manifests beyond the 32-bit byte ceiling and add fill-order bookkeeping indexes.

ALTER TABLE file_manifests MODIFY COLUMN total_bytes BIGINT UNSIGNED NULL;
ALTER TABLE file_manifests ADD COLUMN IF NOT EXISTS filled_at_manifest INT UNSIGNED NULL AFTER status_id;
ALTER TABLE file_parts ADD COLUMN IF NOT EXISTS fill_ordinal INT UNSIGNED NULL AFTER status_id;

CREATE INDEX IF NOT EXISTS source_hash ON file_manifests (source_id, file_hash);
CREATE INDEX IF NOT EXISTS source_hash_fill_ordinal ON file_parts (source_id, file_hash, fill_ordinal);
CREATE INDEX IF NOT EXISTS manifest_action_index ON file_completions (manifest_action_index);
