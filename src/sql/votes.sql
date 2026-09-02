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

-- VOTE ballots. One row per (poll, voter, ballot action, option). APPEND-ONLY:
-- a VOTE v1 carries the voter's whole ballot (one or more options) and the
-- handler INSERTs it as a new set keyed by the v1 action_index, never touching
-- the voter's earlier sets. The voter's CURRENT ballot is their rows at
-- MAX(action_index) for the poll (filtered at tally time, db.getPollTally).
--
-- Append-only is a reorg-safety requirement, not a convenience: the original
-- delete-then-insert design destroyed the prior ballot when a voter re-voted,
-- so a reorg that orphaned the replacing ballot could not restore it (the prior
-- ballot's block is below the rollback point and never reprocesses), forking a
-- reorged node's tally from a from-genesis replay. With append-only sets, the
-- generic action_index rollback deletes the orphaned replacement and the prior
-- set automatically becomes the latest again (same model as vote_delegations).
--
-- Effective weight is NOT stored: it derives from the voter's balance at the
-- effective close block (the hold-to-count gate) split by `share`, computed at
-- tally time (db.getPollTally / VOTE v2). `share` is the voter's relative share
-- for this option in split tally_mode ('1' in approval mode).
--
-- Spec: xchain-documentation/protocol/actions/VOTE.md
DROP TABLE IF EXISTS votes;
CREATE TABLE votes (
    action_index      BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v1 ballot that wrote this row)
    block_index       BIGINT UNSIGNED NOT NULL,   -- cast block (rollback key)
    poll_index        BIGINT UNSIGNED NOT NULL,   -- FK to polls.action_index
    voter_address_id  BIGINT UNSIGNED NOT NULL,   -- FK to index_addresses (the SOURCE that cast the ballot)
    choice            SMALLINT UNSIGNED NOT NULL, -- option index into the poll's options array
    share             VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,                -- relative share for this option (split mode); '1' in approval mode
    memo              MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,                 -- optional voter note
    resolved_block    BIGINT UNSIGNED,            -- reserved for finalization re-arm on reorg (Phase 2)
    status_id         BIGINT UNSIGNED             -- FK to index_statuses (validation status of the ballot action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One row per (poll, voter, ballot action, option): each re-vote is a new
-- action_index set. The composite also serves the current-ballot filter
-- (MAX(action_index) per (poll_index, voter_address_id)) in db.getPollTally.
CREATE UNIQUE INDEX poll_voter_action_choice ON votes (poll_index, voter_address_id, action_index, choice);
CREATE        INDEX poll_index        ON votes (poll_index);
CREATE        INDEX voter_address_id  ON votes (voter_address_id);
CREATE        INDEX action_index      ON votes (action_index);
CREATE        INDEX block_index       ON votes (block_index);
