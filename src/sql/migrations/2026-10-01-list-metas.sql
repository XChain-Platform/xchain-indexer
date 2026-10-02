-- xchain:migration mode=auto
-- Migration: resolved LIST names and descriptions.
--
-- Purely additive and idempotent. The table body matches
-- src/sql/list_metas.sql so migrated and fresh databases converge.

CREATE TABLE IF NOT EXISTS list_metas (
    action_index      BIGINT UNSIGNED NOT NULL,
    list_action_index BIGINT UNSIGNED,
    name              VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    description       VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    memo_id           BIGINT UNSIGNED,
    status_id         BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index      ON list_metas (action_index);
CREATE        INDEX IF NOT EXISTS list_action_index ON list_metas (list_action_index);
CREATE        INDEX IF NOT EXISTS memo_id           ON list_metas (memo_id);
CREATE        INDEX IF NOT EXISTS status_id         ON list_metas (status_id);
