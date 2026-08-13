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

DROP TABLE IF EXISTS contract_delegation_rotations;
CREATE TABLE contract_delegation_rotations (
    id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    target_table              ENUM('contract_stakes','contract_unstakes') NOT NULL, -- which stake-ledger table this rotation rewrote
    delegation_action_index   BIGINT UNSIGNED NOT NULL,        -- FK to contract_delegations.action_index (the DELEGATE v1 whose activation matured)
    stake_action_index        BIGINT UNSIGNED NOT NULL,        -- action_index of the rewritten stake/unstake row (the reorg restore target)
    prev_signing_pubkey_id    BIGINT UNSIGNED NOT NULL,        -- the row's signing_pubkey_id immediately before this rotation; the reorg restore copies it back verbatim
    new_signing_pubkey_id     BIGINT UNSIGNED NOT NULL,        -- the delegated pubkey the row now carries (audit + forward replay)
    block_index               BIGINT UNSIGNED NOT NULL         -- block the rotation was materialized at (= the delegation's activation_block, or the flag-day block for a catch-up); the rollback scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX delegation_action_index ON contract_delegation_rotations (delegation_action_index);
CREATE INDEX block_index             ON contract_delegation_rotations (block_index);
CREATE INDEX stake_row               ON contract_delegation_rotations (target_table, stake_action_index, block_index);
