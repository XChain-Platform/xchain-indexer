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

-- The XBRIDGE action record: one row per user-broadcast XBRIDGE action (v0 lock XCHAIN,
-- v1 burn XCHAIN, v3 lock a token, v4 burn a bridged copy), valid or refused, the way
-- `sends`, `destroys` and `xcalls` each record their own action. The system-injected
-- settle legs (v2, v5) write NO row here: they are applied from a mirrored
-- bridge_transfers row and are recorded in `bridge_settlements`.
--
-- WHY IT EXISTS. The hub's CrossChainBridgeEngine polls the indexer for confirmed locks
-- and burns to sign into a bridge_transfers row; `getpendingbridgetransfers` has nothing
-- to read without this table, and the explorer's action page renders a bridge action
-- from it. A refused action keeps its row (status_id carries the verdict) so the record
-- says what was asked for, which is the convention every action table follows.
--
-- WHAT IS DELIBERATELY NOT STORED HERE, and where a read gets it instead: the SOURCE
-- address is `actions.source_id`, the transaction hash is `transactions` joined to
-- `index_transactions`, the verdict text is `index_statuses`, and `confirmations` is
-- computed at read time as latest_block_index - block_index + 1. That is the same join
-- every other action read already makes (db.js getActionInfo), so duplicating any of it
-- here would be a second copy of a value that can drift.
--
-- There is NO local status-lifecycle column. The hub dedupes a polled leg against its
-- own bridge_transfers table, exactly as it does for cross_chain_calls, so nothing on
-- this chain flips a per-row state and no column here needs to be mutated after the
-- action is recorded.
--
-- Fresh installs get this table from the directory scan in db.verifyTables(); an aged
-- database gets it from src/sql/migrations/2026-09-12-bridge-tables.sql, whose CREATE
-- TABLE block is byte-consistent with this one (sql-schema-column-parity.test.js
-- compares the two paths).
DROP TABLE IF EXISTS xbridges;
CREATE TABLE xbridges (
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
