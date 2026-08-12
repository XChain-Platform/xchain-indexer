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

CREATE TABLE escrow_leaf_journal (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id    BIGINT UNSIGNED NOT NULL,      -- id in index_addresses: the LOCKER, never a recipient
    tick_id       BIGINT UNSIGNED NOT NULL,      -- id in index_tickers
    locked_amount VARCHAR(250),                  -- total open-remaining for this key; NULL = tombstone
    block_index   BIGINT UNSIGNED NOT NULL,      -- block whose processing produced this value
    action_index  BIGINT UNSIGNED                -- causing action, provenance only (NULL for multi-action folds)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Touched set for one block (SPV sub-tree spec §3 Stage B):
--   SELECT DISTINCT address_id, tick_id FROM escrow_leaf_journal WHERE block_index = ?
CREATE INDEX idx_block  ON escrow_leaf_journal (block_index);
-- Latest value per key, and the as-of-height read that serves proofs:
--   SELECT locked_amount ... WHERE address_id=? AND tick_id=? [AND block_index<=?] ORDER BY id DESC LIMIT 1
CREATE INDEX idx_latest ON escrow_leaf_journal (address_id, tick_id, id DESC);

--********************************************************************
-- WHY THIS TABLE EXISTS:
--
-- The `escrows` ledger cannot answer "how much does this address have locked".
-- It is a per-tick CONSERVATION ledger, not a per-address lock ledger: of the 26
-- escrow write sites, four are locks keyed to the locker's SOURCE and 22 are
-- releases, NINE of which key to whoever RECEIVES the funds (order/swap matches
-- key to GET_ADDRESS, dispense and dispenser-close to DESTINATION, cross-settle
-- to payoutAddr). So SUM(escrows) per (address, tick) leaves the locker's key
-- stale-positive and drives the recipient's negative; only the per-tick global
-- sum nets to zero. That is the 2026-06-18 finding, and it is why the escrow
-- leaf cannot be derived from `escrows`.
--
-- The obvious alternative, recomputing each locker's open remaining at read
-- time, is worse than it looks: GIVE_REMAINING IS NOT A STORED COLUMN in ANY
-- family. It is recomputed by db.getOrderAmountsRemaining and
-- db.getDispenserAmountRemaining (the latter folding dispenser EDITs), so
-- "reconstruct as of height H" would mean a SECOND implementation of four
-- families' remaining logic living inside a consensus surface. Two
-- implementations of a computed quantity is the shape that forks.
--
-- So the source computes each key's locked total ONCE, when the block that
-- changes it is processed, using the same house functions that already exist,
-- and appends it here. The table is then shaped exactly like `contract_state`,
-- whose properties Stage A already depends on and has vectors for:
--   * append-only + block_index + idx_block  => the touched set is one indexed
--     query with one answer on both twins;
--   * rollback:'block'                       => a reorg deletes rows >= the
--     orphan height and the next block threads from the surviving root, so
--     there is no repair pass to write or to get wrong;
--   * latest row at or below H               => as-of-height proof reads, the
--     requirement mutable order rows could not meet;
--   * NULL locked_amount                     => the delete-on-zero tombstone,
--     byte-identical in meaning to a NULL contract_state value.
--
-- REPLICATED, NOT RECOMPUTED (replication 'stream:block'). xchain-sync mirrors
-- these rows rather than deriving them, which is what keeps four families'
-- remaining logic from having to exist twice. The follower still recomputes the
-- ROOT from the replicated rows and halts on divergence, exactly as it does for
-- contract state.
--
-- NOT A COMMITMENT. Nothing in this table enters a hash until the escrow leaf is
-- armed (ESCROW_LOCKED_LEAF_ACTIVATION), so it can be populated below an armed
-- height with no consensus effect at all. That is also why Stage B needs no
-- shadow column: the journal IS its own shadow window.
--********************************************************************
