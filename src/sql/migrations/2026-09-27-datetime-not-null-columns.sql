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

-- xchain:migration mode=manual
-- (manual: the auto classifier refuses any MODIFY restating NOT NULL, since
--  it cannot tell that restatement apart from a narrowing.)
--
-- Migration: retype three pre-ledger NOT NULL columns from TIMESTAMP to DATETIME
--
-- WHY
-- ---
-- TIMESTAMP stores UTC and converts on read through the session time_zone, so a
-- row read back under a different time_zone than it was written under shifts.
-- DATETIME stores the literal value with no conversion. cross_chain_calls.created_at,
-- state_checkpoints.created_at and state_tree_roots.computed_at are provenance
-- timestamps, not consensus-visible, and gain nothing from TIMESTAMP's conversion.
--
-- IDEMPOTENT: re-running MODIFY to the same type is a no-op.
--
-- HOW TO RUN
--   node src/db/migration/migrate.js

SET time_zone = '+00:00';
ALTER TABLE cross_chain_calls MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE state_checkpoints MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE state_tree_roots MODIFY computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
