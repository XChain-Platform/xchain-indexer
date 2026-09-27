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
--
-- Migration: created_at TIMESTAMP -> DATETIME on the hub-mirror tables
-- (capability_snapshots, cross_chain_matches, oracle_prices, price_snapshots)
--
-- WHY
-- ---
-- TIMESTAMP converts to/from the session time_zone on every read and write;
-- DATETIME stores exactly what it is given. These four created_at columns are
-- mirror bookkeeping only (never signed into a canonical), so nothing
-- consensus-visible depends on the column type - but converting TIMESTAMP to
-- DATETIME in place makes MariaDB read the stored UTC instant through the
-- session's time zone to produce the new DATETIME value, so a non-UTC session
-- would shift the stored instant. SET time_zone = '+00:00' pins that read to
-- UTC, so the DATETIME this MODIFY writes is byte-identical to the TIMESTAMP
-- it replaces. Forward writes are unaffected either way: coerceMirrorValue
-- (src/hub/hub_db_sync/mirror_write.js) already rewrites an ISO-8601 string
-- into MySQL 'YYYY-MM-DD HH:MM:SS' UTC for any column whose type starts
-- datetime or timestamp, so the hub's own conversion can land before or
-- after this ships.
--
-- IDEMPOTENT: re-running MODIFY to the same type is a no-op, and the
-- schema_migrations ledger records this file once per DB.

SET time_zone = '+00:00';

ALTER TABLE capability_snapshots MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cross_chain_matches MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE oracle_prices MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE price_snapshots MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
