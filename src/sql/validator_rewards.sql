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

DROP TABLE IF EXISTS validator_rewards;
CREATE TABLE validator_rewards (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    reward_type         VARCHAR(20) NOT NULL,             -- 'oracle_round' (legacy/share=0), 'oracle_base' + 'oracle_full_node' (two-tranche split), 'attest_fee', 'anchor_<chain>' (e.g. 'anchor_BTC'), 'anchor_archive'
    round_reference     BIGINT UNSIGNED,                  -- round number or attestation ref
    amount              VARCHAR(250) NOT NULL,
    block_index         BIGINT UNSIGNED NOT NULL,
    -- MATERIALIZATION block . block_index above is the reward's EARN block, which for
    -- an  derived anchor/archive reward is the checkpoint's SNAPSHOT_BLOCK S, a height the
    -- BTC indexer has already passed by the time the mirrored attestation matures. The row is
    -- actually created while processing BTC block B >= S, so a reorg to any height H in (S, B]
    -- orphans the block that MINTED the row while leaving block_index = S below the delete's
    -- scope: the reward survives a reorg a clean replay would not yet have derived, and it stays
    -- COLLECT-spendable. Stamping the creating block here gives rollback a second, correct
    -- scoping key (DELETE ... WHERE derive_block_index >= H). NULL for every reward whose
    -- earn-block IS its materialization block (oracle_*, attest_fee, the legacy hub push, and
    -- the DOGE-side anchor write below the derive flag-day), so the column changes nothing until
    -- ANCHOR_REWARD_DERIVE_ACTIVATION arms.
    derive_block_index  BIGINT UNSIGNED DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX reward_unique     ON validator_rewards (source_id, signing_pubkey_id, reward_type, round_reference);
-- Composite (source_id, block_index): getUnclaimedRewardTotal SUMs a source's rewards
-- per COLLECT, block-scoped for replay determinism. The composite lets the scoped SUM
-- range-scan exactly the source's at-or-before-block rows and covers `WHERE source_id=?`
-- as a leading-column prefix, so it replaces the old single-column source_id index.
CREATE        INDEX source_block       ON validator_rewards (source_id, block_index);
CREATE        INDEX signing_pubkey_id ON validator_rewards (signing_pubkey_id);
CREATE        INDEX block_index       ON validator_rewards (block_index);
-- The reorg delete scopes on derive_block_index >= reorg for derived rewards exactly as it
-- scopes on block_index for every other row, so it needs the same bounded range scan rather
-- than a full scan of the whole reward history.
CREATE        INDEX derive_block_index ON validator_rewards (derive_block_index);
