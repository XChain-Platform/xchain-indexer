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

-- The indexer's MIRROR copy of the hub's policy_snapshots
-- (the token bridge policy spec section 5). Column-for-column the hub table.
-- Shape copied from state_checkpoints: hub-mirrored, applied INSERT IGNORE, append-only,
-- readers take the highest APPLIED policy_seq per (network, origin_chain, tick).
--
-- Fresh installs get this table from the directory scan in db.verifyTables(); an aged
-- database gets it from src/sql/migrations/2026-09-12-bridge-tables.sql, whose CREATE
-- TABLE block is byte-consistent with this one.
CREATE TABLE policy_snapshots (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- mirror cursor (matches hub id)
    snapshot_id          CHAR(64)     NOT NULL,                    -- sha256(network|origin_chain:tick|policy_seq|snapshot_block), lowercase hex
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC-anchored block; selects the cross_chain validator set
    origin_chain         VARCHAR(10)  NOT NULL,                    -- the chain the NATIVE token row lives on
    tick                 VARCHAR(250) NOT NULL,                    -- the native name, never the rooted <ORIGIN>.<NAME> form
    policy_seq           BIGINT UNSIGNED NOT NULL,                 -- 1 for the first snapshot of (network, origin_chain, tick), then +1; ordering only, a gap carries forward
    origin_block         BIGINT UNSIGNED NOT NULL,                 -- the confirmed origin-chain height the policy was read at; signed
    policy_hash          CHAR(64)     NOT NULL,                    -- sha256 over the canonical membership text; the apply recomputes it from the transport arrays and refuses the row on a mismatch
    allow_list           MEDIUMTEXT,                               -- transport JSON array (or NULL); verified against policy_hash, never signed as a field
    block_list           MEDIUMTEXT,                               -- transport JSON array (or NULL); same rule
    sleeping             TINYINT(1)   NOT NULL DEFAULT 0,          -- tick sleep on the origin row; committed through policy_hash only
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- protocol-time instant the apply is due at; NOT monotonic across policy_seq, so apply order is by seq
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed
    finalizing_view      INT          NOT NULL DEFAULT 0,          -- PBFT view the canonical was signed under
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] over the EQUIV-wrapped XPOLICY canonical
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- finalized / retracted
    push_generation      BIGINT       NOT NULL DEFAULT 0,          -- origin-chain reorg fence
    btc_chain_id         CHAR(64),                                 -- hash of BTC block 1 on the writing hub's chain; transport, not consensus
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_policy_seq (network, origin_chain, tick, policy_seq),
    UNIQUE KEY uq_snapshot_id (snapshot_id),
    KEY idx_effective (effective_time),
    KEY idx_origin_tick (origin_chain, tick)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
