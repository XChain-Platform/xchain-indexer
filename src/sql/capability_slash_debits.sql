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

DROP TABLE IF EXISTS capability_slash_debits;
CREATE TABLE capability_slash_debits (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slash_action_index  BIGINT UNSIGNED NOT NULL,        -- FK to actions.action_index (the permissionless SLASH wire action that caused this debit)
    target_table        ENUM('stakes','unstakes') NOT NULL, -- which capability stake-ledger table this debit reduced
    stake_action_index  BIGINT UNSIGNED NOT NULL,        -- action_index of the slashed stakes/unstakes row (the reorg restore target)
    prev_amount         VARCHAR(250) NOT NULL,           -- the row's exact `amount` STRING immediately before this debit; the reorg restore copies it back verbatim (no arithmetic → byte-identical on source + replica)
    amount              VARCHAR(250) NOT NULL,           -- per-row delta this debit subtracted (audit; an equivocation slash burns the whole bond, so this equals prev_amount)
    block_index         BIGINT UNSIGNED NOT NULL         -- block of the slash (= the SLASH action's block); the rollback scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX slash_action_index ON capability_slash_debits (slash_action_index);
CREATE INDEX block_index        ON capability_slash_debits (block_index);
CREATE INDEX stake_row          ON capability_slash_debits (target_table, stake_action_index, block_index);
