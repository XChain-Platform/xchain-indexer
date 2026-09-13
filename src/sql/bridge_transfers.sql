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

-- The indexer's MIRROR copy of the hub's bridge_transfers (the base bridge spec
-- section 6). Column-for-column the hub table minus the hub-only surface; the XBRIDGE
-- pass reads finalized rows from here, verifies the quorum against the mirrored
-- capability_snapshots at snapshot_block, and injects the v2/v5 settle leg.
--
-- Fresh installs get this table from the directory scan in db.verifyTables(); an aged
-- database gets it from src/sql/migrations/2026-09-12-bridge-tables.sql, whose CREATE
-- TABLE block is byte-consistent with this one (sql-schema-column-parity.test.js compares
-- the two paths).
CREATE TABLE bridge_transfers (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- mirror cursor (matches hub id)
    transfer_id          CHAR(64)     NOT NULL,                    -- sha256(network|src_chain:src_action_index|dest_chain:dest_address|snapshot_block), lowercase hex
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC-anchored block; selects the cross_chain validator set for signature verification
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed into the canonical
    src_chain            VARCHAR(10)  NOT NULL,                    -- chain the lock (v0/v3) or burn (v1/v4) was mined on; direction is DERIVED from it and is never a column
    src_action_index     BIGINT UNSIGNED NOT NULL,                 -- the source leg's action_index on src_chain
    src_address          VARCHAR(255) NOT NULL,                    -- the locking/burning source address
    dest_chain           VARCHAR(10)  NOT NULL,                    -- chain the credit lands on
    dest_address         VARCHAR(255) NOT NULL,                    -- address credited by the XBRIDGE v2/v5 settle leg
    tick                 VARCHAR(250) NOT NULL,                    -- the asset's NATIVE tick (never the rooted form); XCHAIN for every base-spec row
    decimals             TINYINT UNSIGNED NOT NULL,                -- the token's DECIMALS (8 for XCHAIN); the precision `amount` is formatted at
    amount               VARCHAR(250) NOT NULL,                    -- decimal string at `decimals` fractional digits; VARCHAR because amounts are bignumber math
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- protocol-time instant every indexer applies at; compared against the block loop's block_time (median-time-past off mainnet)
    finalizing_view      INT          NOT NULL DEFAULT 0,          -- PBFT view the canonical was signed under; rebuilds the exact EQUIV header VIEW
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] over the EQUIV-wrapped canonical
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- finalized / retracted
    push_generation      BIGINT       NOT NULL DEFAULT 0,          -- source-chain reorg fence; an unfenced quorum-class retraction is refused outright
    btc_chain_id         CHAR(64),                                 -- hash of BTC block 1 on the writing hub's chain; NULL accepted by every mirror; transport, not consensus
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_transfer_id (transfer_id),
    KEY idx_snapshot_block (snapshot_block),
    KEY idx_src_ref (src_chain, src_action_index),
    KEY idx_dest_chain (dest_chain),
    KEY idx_effective (effective_time),
    KEY idx_status (status),
    KEY idx_tick (tick)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
