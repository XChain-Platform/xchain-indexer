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
-- WHY: TIMESTAMP converts values through session time_zone; DATETIME stores them
-- literally. These provenance timestamps need no session conversion.
--
-- IDEMPOTENT: re-running MODIFY to the same type is a no-op.
--
-- HOW TO RUN
--   node src/db/migration/migrate.js

SET time_zone = '+00:00';
ALTER TABLE cross_chain_calls MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE state_checkpoints MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE state_tree_roots MODIFY computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
