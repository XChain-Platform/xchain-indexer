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
--
-- Migration: anchor_reward_attestations.created_at  TIMESTAMP -> DATETIME
--
-- mode=manual: MODIFY restates NOT NULL, which the auto-apply destructive-DDL
-- classifier refuses on sight no matter what the retype actually does, so this
-- file can never auto-run and must be applied deliberately via
-- node src/db/migration/migrate.js.
--
-- WHY
-- ---
-- TIMESTAMP stops at 2038 and stores/reads through the session time zone; DATETIME
-- has no such ceiling and holds the literal value. The leading SET pins the session
-- to UTC so the retype keeps the already-stored UTC instant as the DATETIME literal
-- whichever pool or client runs this file.
--
-- IDEMPOTENT: re-running MODIFY to the same type is a no-op, and the schema_migrations
-- ledger records this file once per DB.
--
-- HOW TO RUN
--   node src/db/migration/migrate.js

SET time_zone = '+00:00';

ALTER TABLE anchor_reward_attestations MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
