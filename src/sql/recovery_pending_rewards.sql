--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

DROP TABLE IF EXISTS recovery_pending_rewards;
-- Recovery-local staging for archived validator rewards (F1a id-determinism fix).
--
-- recovery.js used to pre-seed reward-source addresses via createAddress() OUTSIDE a
-- block tx (legacy AUTO_INCREMENT, block_index NULL) BEFORE the reindex. Because
-- getNextAddressId() is MAX(id)+1 over ALL rows, those low pre-seeded ids offset every
-- subsequent in-block deterministic id, so a recovered node built a DIFFERENT
-- index_addresses id map than a from-genesis node (forking ^id resolution and breaking
-- validator_rewards parity across the recovery boundary).
--
-- Instead recovery now stages each archived reward here keyed by the RAW source address
-- string + signing pubkey, assigning NO index id. During the reindex the row materializes
-- into validator_rewards under the deterministic in-block source_id its address takes
-- (db.js createAddress assigns the id; _applyPendingRewardsDueAtBlock lands the reward).
-- The counter is never perturbed out-of-band, so a recovered node reproduces the exact
-- from-genesis id map.
--
-- The landing HEIGHT is the block the reward was originally derived at (its archived
-- block_index + the frozen ANCHOR_REWARD_MIRROR_MATURITY), not the height recovery reached
-- the row at, and that height is stamped on validator_rewards.derive_block_index exactly as
-- a live derivation stamps it. A restored row is therefore indistinguishable from a
-- live-derived one to the reorg-scoping delete and to a COLLECT at any height.
--
-- This is a restore-time scratch artifact: recovery-local, NOT consensus-hashed and NOT
-- replicated by xchain-sync (excluded from replicatedTables.js and from
-- SnapshotBuilder.OPERATOR_LOCAL_TABLES). source_id is NULL until the row is applied;
-- the rollback re-arm (rollback.js) resets applied=0 + source_id=NULL when the materialized
-- source address is rolled out of the index, so a reapply re-runs the hook.
CREATE TABLE recovery_pending_rewards (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_address   VARCHAR(120) NOT NULL,            -- raw staking address string (never an id)
    validator_pubkey CHAR(64) NOT NULL,                -- lowercase hex signing pubkey
    reward_type      VARCHAR(20) NOT NULL,
    round_reference  BIGINT UNSIGNED,
    amount           VARCHAR(250) NOT NULL,
    block_index      BIGINT UNSIGNED NOT NULL,         -- archived reward block (carried onto validator_rewards verbatim)
    source_id        BIGINT UNSIGNED,                  -- deterministic id assigned at materialize time (NULL until applied)
    applied          TINYINT NOT NULL DEFAULT 0,
    applied_block    BIGINT UNSIGNED                    -- block at which this row was (re)materialized (NULL until applied).
                                                        -- The forward-window key xchain-sync uses to stream a survivor row whose
                                                        -- validator_rewards block_index (the EARN block) sits below the replication
                                                        -- window: a reorg re-drain re-materializes a reward earned at E < B, so it
                                                        -- never forward-streams by block_index; the collector selects it by
                                                        -- applied_block (= B). Reset to NULL by the rollback re-arm. Server-local.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX source_address ON recovery_pending_rewards (source_address, applied);
CREATE INDEX applied_block  ON recovery_pending_rewards (applied, applied_block);
