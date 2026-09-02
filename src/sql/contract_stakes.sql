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

DROP TABLE IF EXISTS contract_stakes;
CREATE TABLE contract_stakes (
    action_index           BIGINT UNSIGNED NOT NULL,        -- FK to actions table (each STAKE v3 action gets its own row)
    source_id              BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (staking address)
    version                TINYINT UNSIGNED NOT NULL DEFAULT 3,  -- STAKE format version (3 today, reserved for future variants)
    signing_pubkey_id      BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    target_contract_index  BIGINT UNSIGNED,                 -- FK to contracts.action_index (the contract being staked to); NULL on invalid junk-index actions
    tick_id                BIGINT UNSIGNED,                 -- FK to index_tickers (which token is staked); NULL on invalid actions with an unresolvable TICK
    amount                 VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,           -- Token amount added by this action (active stake = SUM across (target, source, pubkey, tick))
    status_id              BIGINT UNSIGNED,                 -- valid/invalid/etc
    block_index            BIGINT UNSIGNED NOT NULL,
    activation_block       BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- block when this row becomes active (block_index + ACTIVATION_DELAY_BLOCKS)
    deactivation_block     BIGINT UNSIGNED                       -- block when this row becomes inactive (set on UNSTAKE v1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index          ON contract_stakes (action_index);
CREATE        INDEX source_id             ON contract_stakes (source_id);
CREATE        INDEX signing_pubkey_id     ON contract_stakes (signing_pubkey_id);
CREATE        INDEX target_contract_index ON contract_stakes (target_contract_index);
CREATE        INDEX tick_id               ON contract_stakes (tick_id);
CREATE        INDEX status_id             ON contract_stakes (status_id);
CREATE        INDEX activation_block      ON contract_stakes (activation_block);
CREATE        INDEX deactivation_block    ON contract_stakes (deactivation_block);
CREATE        INDEX version               ON contract_stakes (version);
CREATE        INDEX contract_tick         ON contract_stakes (target_contract_index, tick_id);
