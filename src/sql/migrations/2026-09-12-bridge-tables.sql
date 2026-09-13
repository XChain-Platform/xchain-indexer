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

-- xchain:migration mode=manual deploy-precondition=required
-- Migration: the three bridge tables (the base bridge spec section 14,
-- the token bridge policy spec section 6).
--
-- WHY
-- ---
-- bridge_transfers is the hub-mirrored, quorum-signed transfer record the XBRIDGE v2/v5
-- settle leg is injected from. bridge_settlements is the local idempotency and rollback
-- record for every applied leg. policy_snapshots is the hub-mirrored, quorum-signed token
-- policy the destination materializes onto a bridged copy.
--
-- An indexer carrying the bridge code against a database without these tables does not
-- merely miss rows: the mirror stream for a table it cannot write fails by omission, the
-- barrier never opens, and the destination chain silently stops applying transfers whose
-- source legs have already debited on the other side.
--
-- WHY IT IS A DEPLOY PRECONDITION
-- -------------------------------
-- Registered in Database.STARTUP_ASSERTED_MIGRATIONS with the assertion
-- _assertBridgeTablesPresent, so xchain-node's MigrationPreconditionService reads the
-- `deploy-precondition=required` tag out of the source tree it is about to deploy and
-- refuses BEFORE it recreates a container, rather than after (the 2026-08-09 fleet halt).
-- mode=manual is what makes that meaningful: an auto migration applies itself at the first
-- startup that sees it and can never be the missing precondition, and the unit suite
-- test/unit/migration-preconditions.test.js refuses the combination auto + tagged.
--
-- IDEMPOTENT AND NON-DESTRUCTIVE. CREATE TABLE IF NOT EXISTS only; no DROP, so a database
-- whose boot-time verifyTables() already created the tables from src/sql/ records this as
-- applied without touching a row. Each block is copied VERBATIM from its fresh-build
-- definition in src/sql/, which is what keeps SHOW CREATE TABLE identical between a
-- migrated database and a fresh install (test/unit/sql-schema-column-parity.test.js
-- compares the two paths, columns, inline keys and the ENGINE tail alike).
--
-- HOW TO RUN
--   node src/migrate.js --file 2026-09-12-bridge-tables.sql

CREATE TABLE IF NOT EXISTS bridge_transfers (
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

CREATE TABLE IF NOT EXISTS bridge_settlements (
    action_index     BIGINT UNSIGNED NOT NULL, -- internal settle action_index (rollback-able; minted when the leg is applied)
    transfer_id      CHAR(64)        NOT NULL, -- bridge_transfers.transfer_id when kind='transfer', policy_snapshots.snapshot_id when kind='policy'
    kind             VARCHAR(10)     NOT NULL DEFAULT 'transfer', -- 'transfer' (an XBRIDGE v2/v5 leg) | 'policy' (an applied XPOLICY snapshot)
    block_index      BIGINT UNSIGNED NOT NULL, -- block height at which this leg was applied
    -- Source-leg reference captured from the SIGNED row at apply time. The mirror row can
    -- be deleted later, so anything that must survive a retraction reads from here.
    src_chain        VARCHAR(10)     NULL,     -- lock/burn chain (origin_chain for a policy row)
    src_action_index BIGINT UNSIGNED NULL,     -- lock/burn action_index (NULL for a policy row: a snapshot has no single source action)
    dest_chain       VARCHAR(10)     NULL,     -- chain the credit landed on (NULL for a policy row: a snapshot targets every chain holding a copy)
    dest_address     VARCHAR(255)    NULL,     -- address credited (NULL for a policy row)
    tick             VARCHAR(250)    NULL,     -- the native tick the leg moved, as signed
    UNIQUE KEY uq_transfer_kind (transfer_id, kind),
    KEY idx_action_index (action_index),
    KEY idx_block_index (block_index),
    KEY idx_src_ref (src_chain, src_action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE TABLE IF NOT EXISTS policy_snapshots (
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

-- xbridges is the LOCAL action record for every user-broadcast XBRIDGE (v0 lock, v1 burn,
-- v3 lock, v4 burn), the way `sends` and `xcalls` record their own actions. It rides this
-- file rather than a separate migration because it is the SOURCE side of the same barrier
-- the three tables above are the destination side of: an indexer carrying the bridge code
-- against a database without it records no lock and no burn, so the hub's poll finds
-- nothing to sign and every transfer this chain originates silently stops existing, which
-- is the same class of failure this file is already the deploy precondition for. The block
-- is copied verbatim from src/sql/xbridges.sql minus its DROP.
CREATE TABLE IF NOT EXISTS xbridges (
    action_index    BIGINT UNSIGNED NOT NULL,  -- the XBRIDGE action (one row per action, never per leg); the rollback key
    version         TINYINT UNSIGNED,          -- 0=lock XCHAIN, 1=burn XCHAIN, 3=lock a token, 4=burn a bridged copy (matches actions.action_format, nullable for the same reason: an action refused 'invalid: VERSION (unknown)' may carry no numeric version at all, and a NOT NULL column would throw mid-block instead of recording the refusal)
    tick_id         BIGINT UNSIGNED,           -- id of record in index_tickers: the tick AS THE ACTION NAMED IT, so a v4 holds the rooted <ORIGIN>.<NAME> form; a read derives the native name with util.parseBridgedTick
    dest_chain      VARCHAR(10),               -- coin the value is bound for: DEST_COIN (v0/v3), BTC (v1), the bridged row's origin (v4). Stamped by the handler, never a raw wire field
    dest_address_id BIGINT UNSIGNED,           -- id of record in index_addresses: DEST_ADDRESS (v0/v3), BTC_ADDRESS (v1), ORIGIN_ADDRESS (v4)
    amount          VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- the amount exactly as broadcast (the raw wire clone, taken before setNumberFormats)
    decimals        TINYINT UNSIGNED,          -- the token's DECIMALS as read at THIS block; the hub signs it into the transfer record, so a later ISSUE format 7 edit can never restate an accepted lock
    min_depth       BIGINT UNSIGNED,           -- the origin row's MIN_DEPTH as stamped at THIS block, 0 when unset; carried beside the pending row for max(platform depth, min_depth), never signed
    memo_id         BIGINT UNSIGNED,           -- id of record in index_memos table
    status_id       BIGINT UNSIGNED,           -- id of record in index_statuses table (the handler verdict; a refused action keeps its row)
    block_index     BIGINT UNSIGNED NOT NULL,  -- height this action was mined at; the hub's confirmation gate and the reorg delete both key on it
    UNIQUE KEY uq_action_index (action_index),
    KEY idx_tick_id (tick_id),
    KEY idx_dest_address_id (dest_address_id),
    KEY idx_status_id (status_id),
    KEY idx_block_index (block_index),
    -- The hub poll's own index: "unsigned locks and burns of version V at or below height
    -- H", which is a range scan on the leading column without it.
    KEY idx_version_block (version, block_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
