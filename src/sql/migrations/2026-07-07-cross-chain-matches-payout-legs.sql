-- xchain:migration mode=auto
-- Migration: add the cross-chain royalty leg columns to cross_chain_matches.
--
-- Applies to indexer (and hub) databases whose `cross_chain_matches` table was
-- created BEFORE the cross-chain royalty release. The release adds two columns
-- to cross_chain_matches.sql (indexer and hub twins):
--
--   a_payout_legs TEXT   -- A-order royalty split (JSON [{to,bps}], a_chain encoding; NULL = none)
--   b_payout_legs TEXT   -- B-order royalty split (JSON [{to,bps}], b_chain encoding; NULL = none)
--
-- The hub copies each matched order's controller-guard payout_legs into these
-- columns at match formation; at/above the CROSS_CHAIN_ROYALTY flag-day they are
-- signed into the validator match canonical and cross_settle applies them (re-
-- encoded to the proceeds chain) when releasing escrow. Below the flag-day every
-- row's legs are NULL by construction (create-side deny), so the NULL default is
-- also the correct historical value for all pre-release rows.
--
-- The column-drift reconciler (db.js alterTableForDrift, both services) adds
-- these columns automatically on startup; this file is the explicit, auditable
-- migration for operators who prefer to apply it deliberately.
--
-- HOW TO RUN
-- ----------
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-07-cross-chain-matches-payout-legs.sql
--
-- Safe to re-run: each ADD COLUMN is guarded with IF NOT EXISTS (MariaDB). Only
-- adds nullable columns; never drops or rewrites existing data.

ALTER TABLE cross_chain_matches ADD COLUMN IF NOT EXISTS a_payout_legs TEXT AFTER a_payout_addr;
ALTER TABLE cross_chain_matches ADD COLUMN IF NOT EXISTS b_payout_legs TEXT AFTER b_payout_addr;
