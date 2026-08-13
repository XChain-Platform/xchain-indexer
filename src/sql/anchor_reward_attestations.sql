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
--
-- anchor_reward_attestations: reward tuples derived and attested on the BTC side.
--
-- Hub-authored, append-only federation-state table mirrored to every indexer via
-- hub_db_sync (HUB_STATE_TABLES, exactly like state_checkpoints: id-parity INSERT
-- IGNORE, never retracted). The hub INSERTs ONE row per attested reward tuple after
-- the XANCPUB publisher-attestation quorum resolves (v4/v5 per-chain checkpoint reward
-- and v6 archive reward). The BTC indexer keys its reward derivation on these rows:
-- it re-verifies publisher_attestations against its OWN locally-computed oracle_publish
-- set at snapshot_block (the mirror is TRANSPORT, not trust) and materializes the
-- COLLECT-spendable validator_rewards row at block_index = snapshot_block, where the
-- stake source actually resolves (capability staking is BTC-only). ANCHOR is DOGE-only,
-- so without this rail the reward is derived on a DOGE indexer that has no local stake
-- and is silently dropped.
--
-- doge_anchor_txid names the DOGE transaction the rewarded ANCHOR actually landed in. The
-- hub writes the row only after that txid is buried dogeConfirmations deep at the exact
-- ANCHOR version it published (StateAnchorPublisher._drainDeferredRewardAttest), a peer
-- that receives the federated XANCREWARD message re-proves the same thing before writing
-- its copy, and the BTC indexer re-proves it a THIRD time against the DOGE indexer's
-- getanchorconfirmations federation read before minting the reward. Without the column
-- there was nothing for those two independent re-proofs to bind to, so an evicted or
-- reorged anchor left a permanent COLLECT-spendable reward for a transaction the chain
-- never carried. NULL only on rows written before the column existed; such a row can never
-- be proven and derives nothing (fail-closed).
--
-- Forward migration is idempotent and automatic on both sides: the hub and indexer
-- reconcile column drift from this file at startup (db.alterTableForDrift), and the indexer
-- additionally ships the tracked
-- src/sql/migrations/2026-08-13-anchor-reward-attestations-doge-anchor-txid.sql for
-- operators converging a replica by replaying migrations alone.
--
-- Naturally idempotent: the UNIQUE key is the reward tuple identity, so a re-delivered
-- or replayed row is a harmless INSERT IGNORE no-op. A failover double-publish (two
-- publishers for one logical reward) inserts two rows; the BTC-side winner-reconcile
-- (reconcileAnchorRewardWinner) collapses validator_rewards to the smallest-pubkey
-- winner fleet-wide, so the COLLECT rail stays single-winner.

CREATE TABLE anchor_reward_attestations (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- mirror cursor (matches hub id)
    chain                  VARCHAR(10)  NOT NULL,                    -- reward's chain: BTC/LTC/DOGE (or DOGE for archive)
    network                VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest
    reward_type            VARCHAR(32)  NOT NULL,                    -- anchor_<CHAIN> (v4/v5) or anchor_archive (v6)
    round_reference        BIGINT UNSIGNED NOT NULL,                 -- CHECKPOINT_SEQ (v4/v5) or MATCH_BATCH_SEQ (v6)
    snapshot_block         BIGINT UNSIGNED NOT NULL,                 -- BTC block selecting the oracle_publish set + reward block_index
    publisher              VARCHAR(64)  NOT NULL,                    -- elected publisher pubkey (lowercase hex) credited the reward
    reward_amount          VARCHAR(32)  NOT NULL,                    -- audit only; the indexer credits the FROZEN constant, never this wire value
    publisher_attestations TEXT         NOT NULL,                    -- JSON [{pubkey,sig}], the 2f+1 XANCPUB oracle_publish quorum over the reward canonical
    doge_anchor_txid       VARCHAR(64)  DEFAULT NULL,                -- the MINED DOGE ANCHOR this reward is proof-bound to (see the mined-anchor note below)
    created_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Hub-mirrored (hub_db_sync HUB_STATE_TABLES), like state_checkpoints: INSERT-IGNORE
    -- apply, never retracted. Written only AFTER the XANCPUB quorum resolves for a
    -- FINALIZED checkpoint, so there is no un-finalize to retract; a DOGE reorg cannot
    -- un-quorum an already-attested publish, and BTC reorgs unwind the derived reward via
    -- block-scoped rollback (block_index = snapshot_block) + idempotent replay convergence.
    UNIQUE KEY uq_reward_tuple (chain, network, reward_type, round_reference, snapshot_block, publisher),
    KEY idx_snapshot_block (network, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
