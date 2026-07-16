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

-- Full-node possession-proof verifications. One row per (epoch, verified
-- validator): the validator answered the derived possession challenge for
-- `epoch_height` correctly, as attested by a quorum-signed NODEPROOF v0 verdict.
-- Presence of a `passed=1` row within PROOF_WINDOW_BLOCKS of a block — AND a
-- live full_node capability stake at that block — makes the validator a
-- "verified full node" eligible for the full-node reward tranche (see PRICE).
--
-- A single NODEPROOF verdict writes one row per PASS pubkey, all sharing the
-- verdict's action_index — so the generic action-rollback deletes them together
-- on reorg, and xchain-sync replicates them as an action-scoped table. The
-- (epoch_height, signing_pubkey_id) unique key makes replay idempotent.
--
-- Spec: xchain-documentation/protocol/actions/NODEPROOF.md
DROP TABLE IF EXISTS full_node_verifications;
CREATE TABLE full_node_verifications (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,    -- FK to actions (the NODEPROOF verdict that recorded this)
    challenge_id        CHAR(64) NOT NULL,           -- derived id of the challenge epoch
    epoch_height        BIGINT UNSIGNED NOT NULL,    -- challenge epoch block (multiple of CHALLENGE_INTERVAL_BLOCKS)
    target_height       BIGINT UNSIGNED NOT NULL,    -- buried block the possession query targeted (epoch - CONFIRM_DEPTH)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,    -- FK to index_pubkeys (the verified full node)
    source_id           BIGINT UNSIGNED NOT NULL,    -- FK to index_addresses (staking source; per-source dedup for the equal split)
    passed              TINYINT(1) NOT NULL DEFAULT 1,
    block_index         BIGINT UNSIGNED NOT NULL     -- verdict's block (reward-window key + reorg-rollback key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX uq_epoch_pubkey ON full_node_verifications (epoch_height, signing_pubkey_id);
CREATE        INDEX pubkey_block    ON full_node_verifications (signing_pubkey_id, block_index);
CREATE        INDEX source_id       ON full_node_verifications (source_id);
CREATE        INDEX block_index     ON full_node_verifications (block_index);
CREATE        INDEX action_index    ON full_node_verifications (action_index);
CREATE        INDEX challenge_id    ON full_node_verifications (challenge_id);
