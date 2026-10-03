-- xchain:migration mode=auto
-- Migration: list name, description and signed meta hash on the mirrored list versions.
--
-- Additive and idempotent. The columns match src/sql/list_snapshots.sql and sit after
-- members_hash so migrated and fresh databases converge. Rows below the activation
-- carry all three as NULL.

ALTER TABLE list_snapshots
  ADD COLUMN IF NOT EXISTS name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER members_hash,
  ADD COLUMN IF NOT EXISTS description VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER name,
  ADD COLUMN IF NOT EXISTS meta_hash CHAR(64) NULL AFTER description;
