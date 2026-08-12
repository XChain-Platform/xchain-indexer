-- xchain:migration mode=auto
-- Migration: mirror id cursors to BIGINT UNSIGNED, matching the hub DDLs
--
-- Companion of 2026-07-16-mirror-twin-bigint-unsigned-align.sql (which carries
-- the manual-mode retypes of the 8 non-id mirror columns). The three id
-- cursors live in their own AUTO file for one reason: the committed
-- 2026-06-10-mirror-id-autoincrement-repair.sql (mode=auto) MODIFYs these ids
-- to SIGNED `BIGINT NOT NULL AUTO_INCREMENT`, and migrations replay in lexical
-- order on a fresh install, so without a LATER auto file the repair would
-- downgrade a fresh install's ids from the (now UNSIGNED) definitions and the
-- two schema-construction paths would not converge until an operator migrate
-- run. This file applies after it and settles the ids on the hub-parity shape.
--
-- Safe unattended: the ids are AUTO_INCREMENT counters, so every stored value
-- is positive and survives the signed->unsigned retype; NOT NULL is restated,
-- not added (an AUTO_INCREMENT column is definitionally NOT NULL). Restating
-- AUTO_INCREMENT explicitly matters: a bare MODIFY silently strips the
-- attribute (the exact damage the 2026-06-10 file repairs). Idempotent:
-- MODIFY to the already-current definition is a no-op rebuild.

ALTER TABLE cross_chain_matches
    MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE capability_snapshots
    MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE state_checkpoints
    MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
