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

-- VOTE finalized poll results. One row per (poll, option), written by the
-- system-injected VOTE v2 finalize action when a poll reaches its effective close
-- (END_BLOCK, or an early-decide crossing block). This is the frozen, on-chain
-- tally a contract can branch on via the VM host function xchain.getPollResult;
-- unlike the lazy db.getPollTally (a per-request view), these values are immutable
-- once written and identical on every node.
--
-- The per-poll summary (winning_option, status, quorum/min_voters outcome) lives on
-- the `polls` row; this table holds the per-option breakdown. All rows of one
-- finalization share the VOTE v2 action_index, so a reorg past the finalize block
-- removes them via the generic action_index delete in rollback.js (and the polls
-- row is reset in place so the per-block sweep re-finalizes on replay).
--
-- Spec: xchain-documentation/protocol/actions/VOTE.md
DROP TABLE IF EXISTS poll_results;
CREATE TABLE poll_results (
    action_index   BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v2 finalize that wrote this row)
    block_index    BIGINT UNSIGNED NOT NULL,   -- finalize block (rollback key)
    poll_index     BIGINT UNSIGNED NOT NULL,   -- FK to polls.action_index
    option_index   SMALLINT UNSIGNED NOT NULL, -- option index into the poll's options array
    total_weight   VARCHAR(60),                -- counted weight on this option at the effective close
    voter_count    BIGINT UNSIGNED,            -- distinct close-held voters who listed this option
    resolved_block BIGINT UNSIGNED,            -- block finalization went terminal; reorg-rollback reset key
    status_id      BIGINT UNSIGNED             -- FK to index_statuses (status of the finalize action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One row per (poll, option). The poll's full result is all its rows ordered by
-- option_index; a single option is looked up by (poll_index, option_index).
CREATE UNIQUE INDEX poll_option  ON poll_results (poll_index, option_index);
CREATE        INDEX poll_index   ON poll_results (poll_index);
CREATE        INDEX action_index ON poll_results (action_index);
CREATE        INDEX block_index  ON poll_results (block_index);
