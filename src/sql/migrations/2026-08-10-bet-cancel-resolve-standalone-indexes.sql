-- xchain:migration mode=auto
-- Migration: restate the standalone indexes on bet_cancels / bet_resolves.
--
-- WHY
-- ---
-- 2026-07-26-bet-cancel-resolve-status-tables.sql CREATEs both tables but deliberately
-- omits their four standalone indexes each, on the reasoning that reconcileTableIndexes
-- re-adds them from src/sql/bet_cancels.sql / bet_resolves.sql at every boot. That leaves
-- the indexes covered by no schema-parity test at all: the inverse index-parity guard
-- skips ledger-created tables (their CREATE TABLE is the ledger record), and the sibling
-- byte-for-byte body compare in sql-schema-column-parity stops at `) ENGINE...`, so it
-- never sees a standalone `CREATE INDEX ... ON`. An inline `KEY` would have been caught by
-- that body compare; a standalone one falls between the two guards. A later shape change
-- to any of these eight indexes would therefore land on the definition path unobserved.
--
-- 2026-07-28-escrow-leaf-journal-table.sql already takes the other convention and restates
-- its standalone indexes. This migration settles the inconsistency on that side: a
-- migration is self-contained, and the boot-time reconciler is a repair path rather than
-- part of the schema contract (it heals only standalone CREATE INDEX, never an inline KEY,
-- so leaning on it does not generalize). The 2026-07-26 file itself is NOT edited: an
-- applied migration is immutable and its recorded checksum is the ledger, so the correction
-- ships as this new dated file. Its "deliberately not restated here" comment is a record of
-- what was true when it was written, superseded here.
--
-- NOT consensus-visible. Index-only DDL on two DERIVED projection tables that enter no
-- block-hash preimage and no validation or settlement path.
--
-- Additive + idempotent: every statement is CREATE INDEX IF NOT EXISTS, so it is a no-op on
-- the fresh installs and running nodes that already carry these indexes (createTable applies
-- the definitions, and reconcileTableIndexes re-adds them at boot), and it back-fills only a
-- DB converged by replaying the dated migrations alone. Names, column lists, and the UNIQUE
-- flag are byte-equal to the definitions, which sql-schema-index-parity now asserts in both
-- directions.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-10-bet-cancel-resolve-standalone-indexes.sql

CREATE UNIQUE INDEX IF NOT EXISTS action_index      ON bet_cancels (action_index);
CREATE        INDEX IF NOT EXISTS feed_action_index ON bet_cancels (feed_action_index);
CREATE        INDEX IF NOT EXISTS memo_id           ON bet_cancels (memo_id);
CREATE        INDEX IF NOT EXISTS status_id         ON bet_cancels (status_id);

CREATE UNIQUE INDEX IF NOT EXISTS action_index      ON bet_resolves (action_index);
CREATE        INDEX IF NOT EXISTS feed_action_index ON bet_resolves (feed_action_index);
CREATE        INDEX IF NOT EXISTS memo_id           ON bet_resolves (memo_id);
CREATE        INDEX IF NOT EXISTS status_id         ON bet_resolves (status_id);
