-- xchain:migration mode=manual
-- Migration: name the coin behind a market side that carries no ticker, and
-- restore the token/native rows that were never listable.
--
-- WHY
-- ---
-- A market side is either a token (tickN_id -> index_tickers) or the chain's own
-- coin, which has no index_tickers row. The collector coerces that missing ticker
-- id to 0 before it reaches `markets`, and nothing in the row said WHICH coin the
-- 0 stood for, so every reader that resolved a side through index_tickers dropped
-- the pair: a token/native market could hold any number of resting orders and
-- still never appear in the market API or its orderbook.
--
-- coin1_id / coin2_id close that: each side now names the index_coins row it
-- settles in, and a side with tickN_id = 0 is labelled from it.
--
-- The 0 also made two reorg sweeps hostile to these rows. The dangling-tick sweep
-- (`tick1_id NOT IN (SELECT id FROM index_tickers)`) matched 0 and deleted the row,
-- and the zombie probe compared 0 against the NULL that `orders` actually stores,
-- found no survivor and deleted it again. Both now exempt the sentinel, so the
-- rows this migration restores survive a reorg. That is also why step 4 cannot be
-- skipped on a chain that has already reorged: those rows are gone.
--
-- ID STABILITY
-- ------------
-- No step deletes a row that has surviving orders or matches, and no step moves a
-- market_id. That is a hard requirement, not a preference: replicas converge on
-- `markets` through an UPSERT-only snapshot (ClientApplier.upsertFullDumpTables),
-- which can add and overwrite a row but can NEVER remove one. A migration that
-- dropped and re-inserted a pair would leave every replica holding both the old
-- row and the new one, i.e. two rows for one market in every replica-backed
-- explorer, and would move market_id under anyone who stored it.
--
-- The one DELETE (step 2) removes only the SURPLUS rows of a pair that keeps its
-- lowest-id row, which is exactly what the replica's upsert would have collapsed
-- had the key ever bound. On a database the collector wrote it matches nothing:
-- uq_markets_pair already forbids two rows with the same (tick1_id, tick2_id), and
-- the collector never wrote an inverted second row because getMarketId reads both
-- orientations. It exists for a database that took NULL-sided inserts, where NULL
-- is distinct inside a UNIQUE index and the key did not bind.
--
-- MODE
-- ----
-- mode=manual, and it could not be auto even without the DELETE: the auto-
-- eligibility classifier (Database._destructiveStatement) refuses any bare UPDATE
-- outside the AUTO_INCREMENT id-repair shape, and steps 3 and 5 are bare UPDATEs.
-- A mode=auto tag here makes runMigrations throw at boot. `markets` is a DERIVED
-- display aggregate (one row per traded pair, OHLCV recomputed from orders /
-- order_matches) with no consensus reader, so none of this touches consensus
-- state. Rows step 4 inserts carry last_updated NULL, which the indexer's own
-- ageing sweep (getStaleMarkets orders NULL first) refreshes within a few blocks;
-- no operator step fills the stats.
--
-- Step 1 is also applied automatically at boot by the drift reconciler
-- (verifyTables -> alterTableForDrift) from the updated markets.sql, so this file
-- ledgers the column and covers databases not started through the indexer.
-- Idempotent throughout: IF NOT EXISTS on the add, the dedupe matches nothing once
-- deduped, the normalize matches nothing once normalized, the insert anti-joins
-- against the rows it already created, and the backfill is guarded on the 0.
--
-- HOW TO RUN (manual path)
--   node src/migrate.js   (inside the indexer container / service env)

-- (1) The coin behind each side. Anchored explicitly even though the anchors are the
-- table's tail: markets.sql declares them there, and an ADD with no AFTER leaves an aged
-- table in a different column ORDER than a fresh createTable of the same definition.
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS coin1_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_updated,
  ADD COLUMN IF NOT EXISTS coin2_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER coin1_id;

-- (2) Collapse any pair that the NULL era left holding more than one row, keeping the
-- LOWEST id. Runs BEFORE the normalize in step 3, not after: two rows that differ only
-- in a NULL side both normalize onto the same (tick1_id, tick2_id) and the UPDATE would
-- abort on uq_markets_pair. Orientation-free, so (5, NULL) and (NULL, 5) count as the
-- one pair they are. Matches nothing on a collector-written database (see ID STABILITY).
DELETE m FROM markets m
JOIN (
    SELECT LEAST(COALESCE(tick1_id,0), COALESCE(tick2_id,0))    AS lo,
           GREATEST(COALESCE(tick1_id,0), COALESCE(tick2_id,0)) AS hi,
           MIN(id) AS keep_id
    FROM markets
    GROUP BY LEAST(COALESCE(tick1_id,0), COALESCE(tick2_id,0)),
             GREATEST(COALESCE(tick1_id,0), COALESCE(tick2_id,0))
    HAVING COUNT(*) > 1
) dup
  ON LEAST(COALESCE(m.tick1_id,0), COALESCE(m.tick2_id,0))    = dup.lo
 AND GREATEST(COALESCE(m.tick1_id,0), COALESCE(m.tick2_id,0)) = dup.hi
 AND m.id <> dup.keep_id;

-- (3) Normalize any NULL-keyed side onto the 0 sentinel. A NULL side escapes
-- uq_markets_pair entirely (NULL is distinct inside a UNIQUE index), so this is what
-- makes the pair key bind. The row keeps its id and its orientation. No token/token
-- row is touched: index_tickers ids start at 1.
UPDATE markets SET tick1_id = 0 WHERE tick1_id IS NULL;
UPDATE markets SET tick2_id = 0 WHERE tick2_id IS NULL;

-- (4) Create the token/native pairs that have NO row in EITHER orientation, which are
-- the rows the reorg sweeps destroyed. Derived from the pair's own orders and matches,
-- in the orientation createMarket would have used: (get_tick_id, give_tick_id) of the
-- pair's earliest action. `ord_key` is one ordering key across the two source tables,
-- built without assuming their action_index values are disjoint, and breaking a tie
-- toward the order. Picking the earliest action (rather than an arbitrary row) is what
-- makes two nodes running this migration independently store the same orientation.
-- Restricted to same-coin rows, the only market shape the indexer builds today.
INSERT INTO markets (tick1_id, tick2_id, coin1_id, coin2_id)
SELECT
    COALESCE(f.get_tick_id, 0)  AS tick1_id,
    COALESCE(f.give_tick_id, 0) AS tick2_id,
    f.get_coin_id               AS coin1_id,
    f.give_coin_id              AS coin2_id
FROM (
    SELECT o.action_index * 2 AS ord_key,
           o.get_tick_id, o.give_tick_id, o.get_coin_id, o.give_coin_id,
           LEAST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0))    AS lo,
           GREATEST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0)) AS hi
    FROM orders o
    WHERE o.give_coin_id = o.get_coin_id
      AND (o.get_tick_id IS NULL OR o.give_tick_id IS NULL)
    UNION ALL
    SELECT om.action_index * 2 + 1 AS ord_key,
           om.get_tick_id, om.give_tick_id, om.get_coin_id, om.give_coin_id,
           LEAST(COALESCE(om.get_tick_id,0), COALESCE(om.give_tick_id,0))    AS lo,
           GREATEST(COALESCE(om.get_tick_id,0), COALESCE(om.give_tick_id,0)) AS hi
    FROM order_matches om
    WHERE om.give_coin_id = om.get_coin_id
      AND (om.get_tick_id IS NULL OR om.give_tick_id IS NULL)
) f
JOIN (
    SELECT g.lo, g.hi, MIN(g.ord_key) AS first_key
    FROM (
        SELECT o.action_index * 2 AS ord_key,
               LEAST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0))    AS lo,
               GREATEST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0)) AS hi
        FROM orders o
        WHERE o.give_coin_id = o.get_coin_id
          AND (o.get_tick_id IS NULL OR o.give_tick_id IS NULL)
        UNION ALL
        SELECT om.action_index * 2 + 1 AS ord_key,
               LEAST(COALESCE(om.get_tick_id,0), COALESCE(om.give_tick_id,0))    AS lo,
               GREATEST(COALESCE(om.get_tick_id,0), COALESCE(om.give_tick_id,0)) AS hi
        FROM order_matches om
        WHERE om.give_coin_id = om.get_coin_id
          AND (om.get_tick_id IS NULL OR om.give_tick_id IS NULL)
    ) g
    GROUP BY g.lo, g.hi
) k
  ON k.lo = f.lo AND k.hi = f.hi AND k.first_key = f.ord_key
LEFT JOIN (SELECT tick1_id, tick2_id FROM markets) m
  ON (m.tick1_id = f.lo AND m.tick2_id = f.hi)
  OR (m.tick1_id = f.hi AND m.tick2_id = f.lo)
WHERE m.tick1_id IS NULL;

-- (5) Label every remaining unlabelled row, in either orientation, from the pair's own
-- orders. Covers the token/token rows that predate the columns as well as any
-- token/native row step 4 did not have to create. The derived set is keyed
-- orientation-free so exactly one row of it can match a given market, and the
-- give_coin_id = get_coin_id filter makes the two coin ids the same value, so which
-- side each lands on is not a choice this statement has to make.
UPDATE markets m
JOIN (
    SELECT LEAST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0))    AS lo,
           GREATEST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0)) AS hi,
           MIN(o.get_coin_id)  AS c1,
           MIN(o.give_coin_id) AS c2
    FROM orders o
    WHERE o.give_coin_id = o.get_coin_id
    GROUP BY LEAST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0)),
             GREATEST(COALESCE(o.get_tick_id,0), COALESCE(o.give_tick_id,0))
) s
  ON LEAST(m.tick1_id, m.tick2_id)    = s.lo
 AND GREATEST(m.tick1_id, m.tick2_id) = s.hi
SET m.coin1_id = s.c1,
    m.coin2_id = s.c2
WHERE m.coin1_id = 0 OR m.coin2_id = 0;
