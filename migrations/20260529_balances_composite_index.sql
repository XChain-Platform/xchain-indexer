-- Migration: balances composite unique index on (address_id, tick_id)
--
-- Every action handler (send, mint, swap, dispenser, airdrop, …) calls
-- updateAddressBalance(), which issues DELETE / INSERT … ON DUPLICATE KEY
-- against the `balances` table with both address_id AND tick_id in the
-- WHERE / key clause. Without a composite index MariaDB can only use one of
-- the two single-column indices and must filter the second predicate in
-- memory, causing a partial scan proportional to the number of tokens held
-- by each address.
--
-- This migration:
--   1. Aborts if duplicate (address_id, tick_id) pairs exist — dirty data
--      would cause the CREATE UNIQUE INDEX to fail anyway, but a custom
--      error message makes the root cause clear.
--   2. Drops the now-redundant single-column `address_id` index — it is
--      fully covered by the (address_id, tick_id) composite prefix.
--      The single-column `tick_id` index is kept: getTokenSupplyBalance()
--      queries `WHERE tick_id=?` alone and the composite does not cover that.
--   3. Adds UNIQUE INDEX addr_tick (address_id, tick_id).
--      UNIQUE is correct: each (address, token) pair must appear at most once;
--      the existing INSERT … ON DUPLICATE KEY UPDATE relies on this guarantee.
--      IF NOT EXISTS makes the index step safe to re-run.
--
-- Run once on any database created before this index shipped.

-- Step 1: pre-flight duplicate check
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

-- Step 2: drop the redundant single-column address_id index (covered by composite prefix)
ALTER TABLE balances
  DROP INDEX IF EXISTS address_id;

-- Step 3: add the composite unique index
ALTER TABLE balances
  ADD UNIQUE INDEX IF NOT EXISTS addr_tick (address_id, tick_id);
