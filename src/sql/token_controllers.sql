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

DROP TABLE IF EXISTS token_controllers;
CREATE TABLE token_controllers (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,         -- ISSUE action that emitted this bind/unbind event (rollback key)
    tick_id             BIGINT UNSIGNED NOT NULL,         -- FK index_tickers.id (the controlled token)
    action_class        VARCHAR(16) NOT NULL,             -- transfer|trade|burn|mint|stake|ownership
    contract_index      BIGINT UNSIGNED NOT NULL,         -- FK contracts.action_index (the guard contract; on unbind, the contract being dropped)
    bound_by_id         BIGINT UNSIGNED NOT NULL,         -- FK index_addresses.id (token owner who signed the event)
    is_unbind           TINYINT(1) NOT NULL DEFAULT 0,    -- 0 = bind, 1 = unbind (drop request)
    cooldown_blocks     INT UNSIGNED NOT NULL DEFAULT 0,  -- committed at bind; copied onto the unbind event for reference
    cooldown_end_block  BIGINT UNSIGNED,                  -- unbind: block_index + cooldown_blocks (gates until then); NULL on bind
    block_index         BIGINT UNSIGNED NOT NULL          -- block of this event
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Append-only event log: one immutable row per bind/unbind. The effective controller for a
-- (tick, action_class) at block X is the latest event <= X — a `bind` gates; an `unbind` gates
-- only while X < cooldown_end_block (the drop-cooldown's teeth). Cooldown expiry is computed at
-- read time, NOT swept, so rows never mutate and the table rolls back cleanly as a dataTable
-- (DELETE WHERE action_index >= orphan, then forward replay). See Controller_Bound_Tokens.md.

CREATE UNIQUE INDEX action_index   ON token_controllers (action_index);
CREATE        INDEX tick_id        ON token_controllers (tick_id);
CREATE        INDEX contract_index ON token_controllers (contract_index);
CREATE        INDEX tick_class     ON token_controllers (tick_id, action_class);
CREATE        INDEX block_index    ON token_controllers (block_index);
