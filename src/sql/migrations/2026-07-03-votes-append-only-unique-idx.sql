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

-- xchain:migration mode=auto
-- Migration: votes append-only; unique key gains action_index.
--
-- WHY
-- ---
-- The original votes design was last-write-wins: db.createBallot DELETEd the
-- voter's prior rows for the poll before inserting the new set, and the unique
-- index (poll_index, voter_address_id, choice) enforced one live ballot. That
-- destroyed data a reorg needs: when a replacing ballot is orphaned, rollback
-- deletes the replacement generically but the prior ballot's rows are already
-- gone and its block (below the rollback point) never reprocesses, so a reorged
-- node's tally permanently diverges from a from-genesis replay (consensus).
--
-- votes is now append-only (each re-vote INSERTs a new action_index set; the
-- current ballot is the voter's rows at MAX(action_index), filtered in
-- db.getPollTally), so the unique key must include action_index.
--
-- Safe as mode=auto: under the old delete-then-insert writer, existing data has
-- at most one action_index per (poll, voter), so the widened unique key cannot
-- fail on existing rows, and IF [NOT] EXISTS makes a re-run a no-op.

ALTER TABLE votes DROP INDEX IF EXISTS poll_voter_choice;
CREATE UNIQUE INDEX IF NOT EXISTS poll_voter_action_choice ON votes (poll_index, voter_address_id, action_index, choice);
