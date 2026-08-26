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

DROP TABLE IF EXISTS anchor_reward_reconcile_log;
CREATE TABLE anchor_reward_reconcile_log (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    anchor_action_index BIGINT UNSIGNED,                  -- the ANCHOR wire action_index that triggered the reconcile (audit; NULL on the legacy pushvalidatorrewards RPC path, which has no wire action)
    reward_type         VARCHAR(20) NOT NULL,             -- the deleted loser row's reward_type ('anchor_<chain>' / 'anchor_archive')
    round_reference     BIGINT UNSIGNED,                  -- the deleted loser row's round_reference (CHECKPOINT_SEQ for the per-chain legs, MATCH_BATCH_SEQ for 'anchor_archive')
    round_qualifier     BIGINT UNSIGNED NOT NULL DEFAULT 0, -- the deleted loser row's validator_rewards.round_qualifier: snapshot_block for 'anchor_archive' (whose MATCH_BATCH_SEQ round_reference is a reissuable dense counter), 0 for every other reward type. Part of the reward's UNIQUE identity, so the reorg restore and xchain-sync's replica-side mirror of the collapse both need it: keyed on the four older columns alone, a restore or a mirrored DELETE would reach the OTHER snapshot's row for a reissued seq.
    source_id           BIGINT UNSIGNED NOT NULL,         -- deleted row pre-image: staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,         -- deleted row pre-image: FK to index_pubkeys
    amount              VARCHAR(250) NOT NULL,            -- deleted row's exact `amount` STRING; the reorg restore copies it back verbatim (frozen consensus constant per round → no arithmetic, byte-identical on source + replica + replay)
    reward_block_index  BIGINT UNSIGNED NOT NULL,         -- the deleted reward row's ORIGINAL block_index (= the checkpoint's SNAPSHOT_BLOCK, earlier than the reconcile block); the restore only re-inserts losers whose earn-block SURVIVES the reorg
    reward_derive_block_index BIGINT UNSIGNED DEFAULT NULL, -- pre-image of the deleted row's validator_rewards.derive_block_index: the BTC block that MATERIALIZED the loser, NULL when its earn-block was also its materialization block. A loser derived INSIDE the orphaned range must NOT be restored (a replay to reorg-1 never mints it), which reward_block_index alone cannot express because that is the far earlier SNAPSHOT_BLOCK.
    block_index         BIGINT UNSIGNED NOT NULL          -- block of the reconcile (= the ANCHOR action's block); the rollback scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX block_index ON anchor_reward_reconcile_log (block_index);
CREATE INDEX round_ref   ON anchor_reward_reconcile_log (reward_type, round_reference, block_index);
