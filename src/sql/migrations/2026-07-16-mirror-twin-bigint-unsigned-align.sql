-- xchain:migration mode=manual
-- Migration: align mirror-twin BIGINT signedness to the hub source DDLs 
--
-- Four hub-mirrored twins declared 11 columns as signed BIGINT where the hub
-- source of truth (xchain-hub/src/sql/<table>.sql) declares BIGINT UNSIGNED:
--   cross_chain_calls:    target_contract_index, gas_limit, effective_time
--   cross_chain_matches:  id, snapshot_block, a_action_index, b_action_index,
--                         effective_time
--   capability_snapshots: id, snapshot_block
--   state_checkpoints:    id
-- Benign today (all mirrored values are non-negative and inside the signed
-- range) but a systemic parity gap: the two schema-construction paths disagree
-- on the column domain, and a hub id / block height / epoch-time value in the
-- upper unsigned half would overflow the signed twin. The src/sql definitions
-- are aligned in the same change; this migration retrofits DEPLOYED mirror DBs,
-- which the startup drift reconciler cannot do (it only ADDS missing
-- columns/indexes, it never retypes an existing column). The three id-cursor
-- retypes ride in the companion AUTO file
-- 2026-07-16-mirror-id-unsigned-align.sql (see its header for why); this file
-- carries the 8 remaining columns.
--
-- mode=manual: MODIFY restates NOT NULL and narrows the domain (negatives are
-- rejected after the change), so it must never auto-run on a validator fleet;
-- apply deliberately via `node src/migrate.js`. Idempotent: MODIFY to the
-- already-current definition is a no-op rebuild. No data can be lost: every
-- value these mirrors ever store is non-negative (block heights, action
-- indexes, gas limits, epoch seconds).

ALTER TABLE cross_chain_calls
    MODIFY target_contract_index BIGINT UNSIGNED NOT NULL,
    MODIFY gas_limit             BIGINT UNSIGNED NOT NULL,
    MODIFY effective_time        BIGINT UNSIGNED NOT NULL;

ALTER TABLE cross_chain_matches
    MODIFY snapshot_block BIGINT UNSIGNED NOT NULL,
    MODIFY a_action_index BIGINT UNSIGNED NOT NULL,
    MODIFY b_action_index BIGINT UNSIGNED NOT NULL,
    MODIFY effective_time BIGINT UNSIGNED NOT NULL;

ALTER TABLE capability_snapshots
    MODIFY snapshot_block BIGINT UNSIGNED NOT NULL;
