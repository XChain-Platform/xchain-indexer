-- xchain:migration mode=auto
-- Migration: the three ROLLCALL tables (validator liveness eviction).
--
-- WHY
-- ---
-- ROLLCALL adds a presence proof landed on DOGECOIN and judged on BITCOIN. That
-- split is why this is three tables rather than one, and why two of them can
-- never be populated on the same indexer as the third:
--
--   rollcall_signers    DOGE side. A first-seen index of individually verified
--                       signatures. The DOGE indexer has no BTC view, so it
--                       stores raw signed material and decides nothing about
--                       who the signers are.
--   rollcalls           BTC side. One row per epoch that reached its close,
--                       INCLUDING unrolled ones, because the K-streak has to
--                       know which epochs to skip and a missing row is
--                       indistinguishable from an epoch that has not closed.
--                       Carries the pinned responsible set, without which the
--                       streak cannot tell "present" from "was not in R".
--   rollcall_absences   BTC side. One row per responsible source that did not
--                       sign at a ROLLED epoch, pinned at close and never
--                       re-derived, because SLASH rewrites stakes.amount in
--                       place and a later re-derivation can differ.
--
-- Purely additive: three CREATE TABLE IF NOT EXISTS, no column changes, no data
-- migration, nothing dropped. An indexer that has not yet been upgraded simply
-- lacks the tables; it cannot process a ROLLCALL either, since the action is
-- inert below ROLLCALL_ACTIVATION on every network and mainnet ships null.
--
-- NOT parked in the baseline fixtures: the schema-column-parity guard requires a
-- dated migration whose composed shape is byte-identical to the definition
-- files, and forbids baseline-fixture shortcuts for exactly this case.

CREATE TABLE IF NOT EXISTS rollcall_signers (
    epoch_height  BIGINT UNSIGNED NOT NULL,
    pubkey        CHAR(64)        NOT NULL,
    sig           CHAR(128)       NOT NULL,
    ledger_hash   CHAR(64)        NOT NULL,
    publisher     CHAR(64)        NOT NULL,
    action_index  BIGINT UNSIGNED NOT NULL,
    block_index   BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (epoch_height, pubkey),
    KEY idx_rollcall_signers_action (action_index),
    KEY idx_rollcall_signers_block (block_index),
    KEY idx_rollcall_signers_epoch_pub (epoch_height, publisher)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE TABLE IF NOT EXISTS rollcalls (
    epoch_height   BIGINT UNSIGNED NOT NULL,
    snapshot_block BIGINT UNSIGNED NOT NULL,
    close_block    BIGINT UNSIGNED NOT NULL,
    rolled         TINYINT UNSIGNED NOT NULL,
    responsible_set_json LONGTEXT DEFAULT NULL,
    PRIMARY KEY (epoch_height),
    KEY idx_rollcalls_close (close_block),
    KEY idx_rollcalls_rolled (rolled, epoch_height)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE TABLE IF NOT EXISTS rollcall_absences (
    epoch_height BIGINT UNSIGNED NOT NULL,
    source_id    BIGINT UNSIGNED NOT NULL,
    close_block  BIGINT UNSIGNED NOT NULL,
    evicted      TINYINT UNSIGNED NOT NULL,
    PRIMARY KEY (epoch_height, source_id),
    KEY idx_rollcall_absences_source (source_id, epoch_height),
    KEY idx_rollcall_absences_close (close_block),
    KEY idx_rollcall_absences_evicted (evicted, close_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
