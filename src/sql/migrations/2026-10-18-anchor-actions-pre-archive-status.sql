-- xchain:migration mode=auto

ALTER TABLE anchor_actions
  ADD COLUMN IF NOT EXISTS pre_archive_status_id BIGINT UNSIGNED DEFAULT NULL AFTER status_id;
