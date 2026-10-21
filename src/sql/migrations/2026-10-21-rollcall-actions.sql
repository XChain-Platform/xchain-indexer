-- xchain:migration mode=auto
-- Migration: rollcall_actions, one row per valid ROLLCALL action.
--
-- A valid ROLLCALL carrying only pubkeys already landed for its epoch writes no
-- rollcall_signers row (first-seen index), so the explorer could not list it.
-- This table stores the action itself. Purely additive: one CREATE TABLE IF NOT
-- EXISTS, nothing altered or dropped. A replica that lacks it keeps rendering
-- from rollcall_signers through the read-side schema probe.
CREATE TABLE IF NOT EXISTS rollcall_actions (
    action_index     BIGINT UNSIGNED NOT NULL,
    block_index      BIGINT UNSIGNED NOT NULL,
    epoch_height     BIGINT UNSIGNED NOT NULL,
    ledger_hash      CHAR(64)        NOT NULL,
    publisher        CHAR(64)        NOT NULL,
    gates            TEXT            DEFAULT NULL,
    carried_count    INT UNSIGNED    NOT NULL,
    first_seen_count INT UNSIGNED    NOT NULL,
    PRIMARY KEY (action_index),
    KEY idx_rollcall_actions_epoch (epoch_height, action_index),
    KEY idx_rollcall_actions_block (block_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
