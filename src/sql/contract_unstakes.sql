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

DROP TABLE IF EXISTS contract_unstakes;
CREATE TABLE contract_unstakes (
    action_index           BIGINT UNSIGNED NOT NULL,
    source_id              BIGINT UNSIGNED NOT NULL,
    signing_pubkey_id      BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (which contract-stake is being unstaked)
    target_contract_index  BIGINT UNSIGNED,                 -- FK to contracts.action_index; NULL on invalid junk-index actions
    tick_id                BIGINT UNSIGNED,                 -- FK to index_tickers (which token); NULL on invalid actions with an unresolvable TICK
    cooldown_end_block     BIGINT UNSIGNED NOT NULL,        -- block when funds release (block_index + contracts.cooldown_blocks)
    amount                 VARCHAR(250) NOT NULL,           -- Total amount being unstaked (sum of active contract_stakes rows for this (target, pubkey, tick))
    status_id              BIGINT UNSIGNED,                 -- pending/completed/cancelled
    block_index            BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index          ON contract_unstakes (action_index);
CREATE        INDEX source_id             ON contract_unstakes (source_id);
CREATE        INDEX signing_pubkey_id     ON contract_unstakes (signing_pubkey_id);
CREATE        INDEX target_contract_index ON contract_unstakes (target_contract_index);
CREATE        INDEX tick_id               ON contract_unstakes (tick_id);
CREATE        INDEX cooldown_end_block    ON contract_unstakes (cooldown_end_block);
CREATE        INDEX status_id             ON contract_unstakes (status_id);
-- Composite for the per-block cooldown sweep (status_id filter + cooldown_end_block range).
CREATE        INDEX status_cooldown       ON contract_unstakes (status_id, cooldown_end_block);
