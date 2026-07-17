-- xchain:migration mode=manual
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

-- Migration: reposition contract_state.state_key_bin to AFTER state_key on
-- aged databases (follow-up to 2026-07-10-contract-state-bin-key-index.sql).
--
-- The 2026-07-10 file originally shipped a bare ADD COLUMN (which appends),
-- was later edited in place to add `AFTER state_key`, and the edit was healed
-- through MIGRATION_CHECKSUM_REBASELINES, which updates the ledger checksum
-- WITHOUT re-running the file. Its IF NOT EXISTS clause no-ops on databases
-- that already applied the pre-edit form, and the startup drift reconciler
-- (alterTableForDrift) only positions MISSING columns, never repositions an
-- existing one. So the exact population this manual path exists for
-- (operator-managed / rebuilt replicas that do not run the reconciler) kept
-- state_key_bin at the table TAIL, a permanent SHOW CREATE TABLE divergence
-- from fresh installs, which follow contract_state.sql and place it between
-- state_key and state_value.
--
-- MODIFY re-lands the position with the definition copied VERBATIM from
-- contract_state.sql (only the position changes; the column is VIRTUAL, so
-- no stored data is touched). On fresh installs (or reconciler-started nodes)
-- the column is already after state_key and the reorder is a no-op by intent.
-- Repositioning can still trigger a table copy on large contract_state
-- instances, and some MySQL/MariaDB versions reject in-place ALGORITHM for
-- generated-column reorders; run in a maintenance window on big replicas.
-- Row content, GROUP BY semantics, and idx_latest_bin are all unchanged:
-- this is ordering-convergence only.
--
-- HOW TO RUN (manual path)
--   node src/migrate.js   (inside the indexer container / service env)

ALTER TABLE contract_state
    MODIFY COLUMN state_key_bin VARCHAR(256) CHARACTER SET utf8 COLLATE utf8_bin
        GENERATED ALWAYS AS (state_key) VIRTUAL
        AFTER state_key;
