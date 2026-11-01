-- xchain:migration mode=auto

ALTER TABLE state_checkpoints
  ADD COLUMN IF NOT EXISTS supersedes_from BIGINT UNSIGNED DEFAULT NULL AFTER snapshot_block,
  ADD COLUMN IF NOT EXISTS rules_digest CHAR(64) DEFAULT NULL AFTER supersedes_from;
