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
-- Migration: widen polls.weight_mode ENUM to add 'quadratic' and 'time_weighted'.
--
-- WHY
-- ---
-- Phase 3 of the VOTE governance action adds two anti-whale weight modes
-- (quadratic = sqrt(close balance), time_weighted = windowed average holdings).
-- The polls table was created in Phase 1 with ENUM('balance','stake','flat'). The
-- startup drift reconciler (verifyTables -> alterTableForDrift) reconciles column
-- nullability and indexes but NOT enum value-set changes, so an existing polls
-- table never gains the new values and a quadratic / time_weighted poll would
-- store '' (an out-of-set enum truncates to empty). This widens the enum so the
-- new modes persist.
--
-- Additive + idempotent: MODIFY COLUMN only adds permitted values, leaves existing
-- rows untouched, and re-running to the same definition is a no-op. Snapshot-
-- bootstrapped sync replicas inherit the wider enum from the source's
-- SHOW CREATE TABLE, so only live (non-bootstrapped) indexer DBs need this runner.

ALTER TABLE polls
  MODIFY COLUMN weight_mode ENUM('balance','stake','flat','quadratic','time_weighted');
