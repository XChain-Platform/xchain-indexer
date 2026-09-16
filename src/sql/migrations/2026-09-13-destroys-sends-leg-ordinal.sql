-- xchain:migration mode=auto
-- Migration: give destroys and sends a leg ordinal, so a multi-leg action's
-- broadcast order is recorded rather than inferred.
--
-- WHY
-- ---
-- A multi-send, and since 2026-08-15 a multi-destroy, writes ONE ROW PER LEG under one
-- action_index. Neither table had a primary key or any position column, so the wire
-- order of those legs was stored nowhere. A reader had exactly two bad choices: sort on
-- a value column, which silently contradicts the transaction (the explorer's DESTROY leg
-- list did this and read RDOGE action 1183 back as XCHAIN then CAMPB, the reverse of the
-- broadcast), or take the rows in whatever order the engine hands them back, which is
-- physical insertion order today and is guaranteed by nothing: SQL defines no order for a
-- SELECT without ORDER BY, and a page split, a re-parse or a different plan can change it.
--
-- leg_ordinal is that missing position: 0-based, assigned by the writer (db.js
-- createSend / createDestroy) from the order the action loop settles the legs, which is
-- wire order. Readers ORDER BY (action_index, leg_ordinal) and get the broadcast back.
--
-- NOT consensus-visible. Both tables are DERIVED in src/tableLifecycle.js: a deterministic
-- projection of hashed actions, in no hash class of their own, rolled back by
-- `action_index >= ?` which is row-count and column agnostic. Balances have always been
-- debited per leg in memory by the action loop, so this is the read model only.
--
-- NOT NULL DEFAULT 0, and deliberately NOT UNIQUE per (action_index, leg_ordinal): every
-- row written before this column existed takes 0, so an aged multi-leg action carries a
-- whole set of zeroes and a unique index could not be created at all. A tie on 0 degrades
-- to exactly today's behaviour (insertion order) for history and is exact for everything
-- indexed afterward. A database that wants its history ordered needs a reindex from below
-- the first multi-leg action, the same remedy the 2026-08-15 destroys migration names.
--
-- The composite index serves the read: ORDER BY on the same action_index the WHERE pins,
-- so the sort is satisfied from the index rather than a filesort. The pre-existing
-- single-column `action_index` index is left alone; it is still the index other queries
-- on these tables were planned against.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, a no-op on
-- any install whose boot-time reconcileTableIndexes/alterTableForDrift has already healed
-- them in from the definitions in src/sql/. Each column is declared LAST in its definition
-- and anchored here with AFTER status_id, so SHOW CREATE TABLE stays byte-equal between a
-- migrated DB and a fresh install (the column-parity test checks position).
--
-- HOW TO RUN (manual path)
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-09-destroys-sends-leg-ordinal.sql

ALTER TABLE destroys
  ADD COLUMN IF NOT EXISTS leg_ordinal SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER status_id;

ALTER TABLE sends
  ADD COLUMN IF NOT EXISTS leg_ordinal SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER status_id;

CREATE INDEX IF NOT EXISTS action_leg ON destroys (action_index, leg_ordinal);
CREATE INDEX IF NOT EXISTS action_leg ON sends (action_index, leg_ordinal);
