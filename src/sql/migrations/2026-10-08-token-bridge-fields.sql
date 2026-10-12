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
-- Migration: issuer bridge opt-in fields for ISSUE format 7
-- (the token bridge spec section 7).
--
-- WHY
-- ---
-- Bridgeability is a property the owner sets on the ORIGIN token row, default off: which
-- destination coins a token may be locked to (BRIDGE_CHAINS), the confirmation depth the
-- federation must honour for its locks (MIN_DEPTH), and a one-way freeze of both
-- (LOCK_BRIDGE) that is the holder's assurance against the owner and against a new owner
-- after a format 0 TRANSFER. `tokens.bridged` is the fourth column and is not an ISSUE
-- field: it is set by the first applied XBRIDGE v3 lock and never cleared in milestone 1,
-- so emptying BRIDGE_CHAINS after bridging cannot reopen policy binding while copies are
-- outstanding.
--
-- TWO SHAPES ON PURPOSE. `issues` stores RAW WIRE STRINGS, like every other column on that
-- table: an EMPTY field means "unchanged" and is back-filled from the current row
-- (issue.js), which a typed NOT NULL column cannot express, and a numeric column would
-- lose the un-parsed wire text. `tokens` stores the PARSED values the reads and the v3
-- lock consult. This is the same split mint_start_block and lock_mint already use.
--
-- CONSENSUS. Action-derived from `issues`, so the fields are already inside actions_hash;
-- no stateHash.js class is added for them. Format 7 itself is gated on
-- TOKEN_BRIDGE_ACTIVATION: below it the parse verdict stays `invalid: VERSION (unknown)`,
-- so no historical ISSUE on any chain changes status on replay.
--
-- mode=auto: additive ADD COLUMN IF NOT EXISTS only, every column nullable or carrying a
-- DEFAULT, so it backfills existing rows and is a no-op on any install whose boot-time
-- alterTableForDrift has already healed the columns in from src/sql/. Each column is
-- declared LAST in its definition and anchored here with AFTER, so SHOW CREATE TABLE stays
-- byte-equal between a migrated database and a fresh install (the column-parity test
-- checks position as well as shape).
--
-- HOW TO RUN
--   node src/migrate.js --file 2026-09-12-token-bridge-fields.sql

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS bridge_chains VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci AFTER status_id,
  ADD COLUMN IF NOT EXISTS min_depth VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci AFTER bridge_chains,
  ADD COLUMN IF NOT EXISTS lock_bridge VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci AFTER min_depth;

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS bridge_chains VARCHAR(250) AFTER coin_floor,
  ADD COLUMN IF NOT EXISTS min_depth BIGINT UNSIGNED AFTER bridge_chains,
  ADD COLUMN IF NOT EXISTS lock_bridge TINYINT(1) NOT NULL DEFAULT 0 AFTER min_depth,
  ADD COLUMN IF NOT EXISTS bridged TINYINT(1) NOT NULL DEFAULT 0 AFTER lock_bridge;
