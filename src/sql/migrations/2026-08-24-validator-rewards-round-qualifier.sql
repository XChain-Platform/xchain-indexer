-- xchain:migration mode=manual
-- Migration: validator_rewards.round_qualifier + anchor_reward_reconcile_log.round_qualifier,
--            and the validator_rewards UNIQUE key rebuilt to include it.
--
-- WHY
-- ---
-- A validator reward is identified by (source_id, signing_pubkey_id, reward_type,
-- round_reference). For every reward type but one, round_reference is safe as an identity:
-- the per-chain anchor legs use CHECKPOINT_SEQ, which equals the checkpoint's snapshot_block,
-- a chain height that only advances and can never be reissued.
--
-- The ARCHIVE leg is the exception. anchor_archive keys on MATCH_BATCH_SEQ, a DENSE counter
-- the hub allocates from its own tables, and those tables are reset by a wipe-and-replay
-- rebase. After a rebase the hub reissues seq values earlier archive batches already used, so
-- two genuinely distinct archive anchors - different snapshot blocks, different quorum-attested
-- publishes, each owed its own reward - present the same round_reference.
--
-- The reward ledger could not tell them apart, while the SIGNED side always could: the XANCPUB
-- reward canonical carries SNAPSHOT_BLOCK next to MATCH_BATCH_SEQ, and anchor_reward_attestations'
-- uq_reward_tuple includes snapshot_block. Only the ledger key and the reconcile predicate
-- dropped it. Two real archive anchors therefore collapsed into one paid reward:
--   * the pending-attestation NOT EXISTS matched on (reward_type, round_reference) alone, so
--     the second archive reward was never derived at all; and
--   * where both rows did land, the reconcile DELETE kept only MIN(pubkey), so one real,
--     quorum-attested publisher was paid nothing.
--
-- round_qualifier closes that: it carries snapshot_block for anchor_archive and 0 for every
-- other reward type, and joins the UNIQUE key. Non-archive rows keep exactly the key they had.
--
-- NOT NULL DEFAULT 0, NEVER NULLABLE. MariaDB treats NULLs as DISTINCT inside a UNIQUE index,
-- so a nullable qualifier would silently stop deduplicating EVERY reward row the moment one
-- writer left it unset - an idempotency loss on a COLLECT-spendable table, not a cosmetic one.
-- DEFAULT 0 is also what makes this migration byte-neutral for existing history: every row
-- already written takes qualifier 0, so its key is unchanged and the rebuilt UNIQUE index
-- cannot find a new duplicate to reject.
--
-- CONSENSUS-RELEVANT SURFACE, NOT A CONSENSUS CHANGE. validator_rewards is COLLECT-spendable
-- and is replicated to validators by xchain-sync (stream:block), and anchor_reward_reconcile_log
-- carries the loser pre-images the reorg restore re-INSERTs, so this is a coordinated FLEET
-- migration: apply it EVERYWHERE BEFORE any ANCHOR_REWARD_DERIVE_ACTIVATION height is ratified
-- on mainnet/testnet. A node missing it keys archive rewards differently from a node carrying
-- it, which is a COLLECT-rail divergence rather than a startup error. It is byte-neutral while
-- that gate is inert: no archive reward is being derived, so every row takes the default 0 and
-- the rebuilt key matches the old one exactly.
--
-- HOW THE SCHEMA ACTUALLY ARRIVES, stated exactly, because the two halves differ.
--   * The COLUMNS converge on their own. Both are declared NOT NULL *with a DEFAULT* in
--     src/sql/validator_rewards.sql and src/sql/anchor_reward_reconcile_log.sql, so
--     alterTableForDrift ADDs them (the skip at src/db.js:1073 is NOT-NULL-with-NO-DEFAULT),
--     and verifyTables() runs before runMigrations() at startup. Any node that boots this
--     build has the columns whether or not anyone runs this file.
--   * The UNIQUE KEY does NOT. reconcileTableIndexes refuses to touch an index whose name is
--     already held by a differently-defined live index (src/db.js:1213) - it will never DROP
--     an index it did not create - so on an AGED database `reward_unique` stays the OLD
--     four-column index and the boot log carries a "cannot be applied" drift warning every
--     start. A FRESH install gets the five-column index from validator_rewards.sql directly.
-- So this file is the ONLY convergence path for the key on an existing database, which is
-- what mode=manual is carrying here: not a fleet-coordination claim the tag cannot enforce,
-- but the explicit, auditable apply path for the one object nothing else will heal.
--
-- WHAT THE FLEET HAS TO AGREE ON before any ANCHOR_REWARD_DERIVE_ACTIVATION height is
-- ratified is therefore BOTH halves: the build (a binary carrying the qualifier-aware
-- writers, reconcile and pending-join) AND this file applied on every aged database. A node
-- with the new build but the old four-column key silently re-collapses two distinct archive
-- rewards inside its own UNIQUE index - the exact defect this closes - and forks the COLLECT
-- rail against its peers. The boot warning above is the tell; the migration is the fix.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-24-validator-rewards-round-qualifier.sql

ALTER TABLE validator_rewards
  ADD COLUMN IF NOT EXISTS round_qualifier BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER round_reference;

-- Rebuild reward_unique with the qualifier appended. Dropping first keeps this idempotent:
-- a re-run drops the already-correct index and recreates the identical definition, and no
-- duplicate can appear in between because every pre-existing row carries qualifier 0.
ALTER TABLE validator_rewards
  DROP INDEX IF EXISTS reward_unique;

ALTER TABLE validator_rewards
  ADD UNIQUE INDEX IF NOT EXISTS reward_unique
      (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier);

-- The reconcile log pre-images a deleted loser's full ledger identity, so it needs the same
-- column or the reorg restore (and xchain-sync's replica-side mirror of the collapse) would
-- key the pre-image on a tuple that no longer identifies one row.
ALTER TABLE anchor_reward_reconcile_log
  ADD COLUMN IF NOT EXISTS round_qualifier BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER round_reference;
