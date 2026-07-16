-- xchain:migration mode=auto
-- Migration: restore the stripped AUTO_INCREMENT on the hub-mirror id cursors
--
-- The startup drift reconciler (db.js alterTableForDrift) read source lines of
-- the form `id BIGINT AUTO_INCREMENT PRIMARY KEY` as "nullable" (no explicit
-- NOT NULL keyword; column-level PRIMARY KEY / AUTO_INCREMENT imply NOT NULL,
-- which the parser didn't know), decided the live NOT NULL column was drift,
-- and "relaxed" it with a bare `MODIFY <type> NULL` — which silently STRIPS
-- the AUTO_INCREMENT attribute. This re-ran on EVERY startup, so any table
-- whose source declared the id that way lost its auto-increment:
-- price_snapshots, cross_chain_matches, capability_snapshots,
-- state_checkpoints. (Tables spelling out `NOT NULL AUTO_INCREMENT`, e.g.
-- blocks and oracle_prices, were never touched.) The reconciler is fixed
-- alongside this migration (parseExpectedColumns + a PK/auto-inc guard in the
-- relax branch) and the four source files now carry an explicit NOT NULL;
-- this migration repairs databases that were already damaged.
--
-- Observable damage: an id-omitting INSERT defaults id to 0; the first such
-- row lands at id=0 and every later one collides with it on the PRIMARY KEY —
-- and the writers here all use INSERT IGNORE, so the loss is SILENT
-- (affectedRows=0). Hub-connected mirrors are mostly unaffected (mirror rows
-- carry explicit hub ids), but single-host installs (hub sharing the indexer
-- DB) and local seeding paths lose every row after the first. Live-diagnosed
-- during the ANCHOR regtest acceptance, 2026-06-10.
--
-- Each repair re-keys a possible legacy id=0 row first (the ALTER rebuild
-- resequences zero ids and the regenerated value can collide), then restores
-- the attribute. Idempotent: MODIFY to the same definition is a no-op, the
-- UPDATE matches nothing once no id=0 row exists. The id is a mirror paging
-- cursor, not a foreign key — re-keying a row later in cursor order is
-- tolerated by the INSERT-IGNORE mirror apply (worst case a re-receive).
--
-- OPS RUNBOOK: This migration runs automatically on origin indexers at startup.
-- Replicas bootstrapped from a stripped-state origin (i.e. bootstrapped BEFORE
-- this migration was applied on the origin) cloned the stripped DDL and have NO
-- automated repair path — xchain-sync's addMissingColumns only adds absent
-- columns, it does not repair column attributes such as AUTO_INCREMENT. For any
-- such replica, apply the four MODIFY statements above manually (or re-bootstrap
-- the replica from a repaired origin after this migration has run there).

UPDATE price_snapshots
   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM price_snapshots) t)
 WHERE id = 0;
ALTER TABLE price_snapshots
    MODIFY id BIGINT NOT NULL AUTO_INCREMENT;

UPDATE cross_chain_matches
   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM cross_chain_matches) t)
 WHERE id = 0;
ALTER TABLE cross_chain_matches
    MODIFY id BIGINT NOT NULL AUTO_INCREMENT;

UPDATE capability_snapshots
   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM capability_snapshots) t)
 WHERE id = 0;
ALTER TABLE capability_snapshots
    MODIFY id BIGINT NOT NULL AUTO_INCREMENT;

UPDATE state_checkpoints
   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM state_checkpoints) t)
 WHERE id = 0;
ALTER TABLE state_checkpoints
    MODIFY id BIGINT NOT NULL AUTO_INCREMENT;
