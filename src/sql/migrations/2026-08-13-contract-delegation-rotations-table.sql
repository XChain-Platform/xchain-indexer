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
-- Migration: create contract_delegation_rotations
--
-- WHY
-- ---
-- A DELEGATE v1 signing-key rotation used to stop at contract_delegations, while every
-- contract-stake lookup surface (the VM stake snapshot, the UNSTAKE refund aggregate and the
-- SLASH deduction) keys on contract_stakes.signing_pubkey_id. At/after the
-- CONTRACT_DELEGATION_MATERIALIZE flag-day the rotation is materialized onto contract_stakes
-- by an in-place UPDATE of a SURVIVING row, and an in-place mutation of a surviving row needs
-- a journal for two reasons: a reorg has to restore the previous key verbatim (the generic
-- block delete cannot revert an UPDATE), and xchain-sync has to carry the mutated row to
-- followers through the updated-rows channel, which finds such rows through their journal.
-- Same shape and the same reasons as contract_slash_debits.
--
-- CONSENSUS IS NOT AFFECTED BY THIS MIGRATION. The table is created EMPTY and nothing writes
-- it below the flag-day (mainnet 2026-10-01T00:00:00Z; testnet/regtest from genesis, where a
-- fresh stack starts empty anyway). Creating it ahead of the flag-day is deliberate: it is a
-- replicated table, so it must exist on every replica before the first row is streamed.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS. The CREATE TABLE is kept
-- character-for-character equivalent to src/sql/contract_delegation_rotations.sql, with the
-- indexes declared separately afterwards exactly as the definition does, because the
-- schema-parity gate compares the two normalised forms: a migrated replica and a fresh install
-- must converge on the same table, not merely a compatible one.

CREATE TABLE IF NOT EXISTS contract_delegation_rotations (
    id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    target_table              ENUM('contract_stakes','contract_unstakes') NOT NULL, -- which stake-ledger table this rotation rewrote
    delegation_action_index   BIGINT UNSIGNED NOT NULL,        -- FK to contract_delegations.action_index (the DELEGATE v1 whose activation matured)
    stake_action_index        BIGINT UNSIGNED NOT NULL,        -- action_index of the rewritten stake/unstake row (the reorg restore target)
    prev_signing_pubkey_id    BIGINT UNSIGNED NOT NULL,        -- the row's signing_pubkey_id immediately before this rotation; the reorg restore copies it back verbatim
    new_signing_pubkey_id     BIGINT UNSIGNED NOT NULL,        -- the delegated pubkey the row now carries (audit + forward replay)
    block_index               BIGINT UNSIGNED NOT NULL         -- block the rotation was materialized at (= the delegation's activation_block, or the flag-day block for a catch-up); the rollback scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX IF NOT EXISTS delegation_action_index ON contract_delegation_rotations (delegation_action_index);
CREATE INDEX IF NOT EXISTS block_index             ON contract_delegation_rotations (block_index);
CREATE INDEX IF NOT EXISTS stake_row               ON contract_delegation_rotations (target_table, stake_action_index, block_index);
