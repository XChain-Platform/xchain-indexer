-- xchain:migration mode=auto
-- Migration: transferred-list ownership history.
--
-- Purely additive and idempotent. The table body matches
-- src/sql/list_transfers.sql so migrated and fresh databases converge.

CREATE TABLE IF NOT EXISTS list_transfers (
    action_index      BIGINT UNSIGNED NOT NULL,
    list_action_index BIGINT UNSIGNED,
    destination_id   BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index      ON list_transfers (action_index);
CREATE        INDEX IF NOT EXISTS list_action_index ON list_transfers (list_action_index);
CREATE        INDEX IF NOT EXISTS destination_id    ON list_transfers (destination_id);
