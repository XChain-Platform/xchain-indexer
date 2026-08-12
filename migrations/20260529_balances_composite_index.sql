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

-- Migration: balances composite unique index on (address_id, tick_id)
--
-- Every action handler calls updateAddressBalance(), which issues DELETE / INSERT …
-- ON DUPLICATE KEY against `balances` keyed on both address_id and tick_id. Without a
-- composite index MariaDB can only use one of the two single-column indices and must
-- filter the other predicate in memory, an O(n) scan per address's held tokens.
--
-- The pre-flight check aborts with a clear error if duplicate (address_id, tick_id)
-- pairs exist, since dirty data would otherwise fail the CREATE UNIQUE INDEX with a
-- confusing error. The single-column address_id index is dropped as redundant (covered
-- by the composite prefix), but tick_id is kept since getTokenSupplyBalance() queries
-- it alone. UNIQUE is required: the existing ON DUPLICATE KEY UPDATE assumes each
-- (address, token) pair appears at most once. IF NOT EXISTS makes this safe to re-run.
--
-- Run once on any database created before this index shipped.

DROP PROCEDURE IF EXISTS _balances_dedup_check;
DELIMITER //
CREATE PROCEDURE _balances_dedup_check()
BEGIN
    DECLARE dup_count INT DEFAULT 0;
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT address_id, tick_id
        FROM balances
        GROUP BY address_id, tick_id
        HAVING COUNT(*) > 1
    ) AS dups;
    IF dup_count > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'MIGRATION ABORTED: balances table contains duplicate (address_id, tick_id) pairs. Inspect with: SELECT address_id, tick_id, COUNT(*) FROM balances GROUP BY address_id, tick_id HAVING COUNT(*) > 1';
    END IF;
END//
DELIMITER ;
CALL _balances_dedup_check();
DROP PROCEDURE IF EXISTS _balances_dedup_check;

ALTER TABLE balances
  DROP INDEX IF EXISTS address_id;

ALTER TABLE balances
  ADD UNIQUE INDEX IF NOT EXISTS addr_tick (address_id, tick_id);
