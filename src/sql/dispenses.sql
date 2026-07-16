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

DROP TABLE IF EXISTS dispenses;
CREATE TABLE dispenses (
    action_index             BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index   BIGINT UNSIGNED,          -- action_index of dispenser
    give_coin_id             BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id             BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount              VARCHAR(250),             -- Amount dispensed (GIVE_TICK)
    get_coin_id              BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id              BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount               VARCHAR(250),             -- Amount paid (GET_COIN or GET_TICK)
    destination_id           BIGINT UNSIGNED,          -- id of record in index_addresses table
    status_id                BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenses (action_index);
CREATE        INDEX dispenser_action_index ON dispenses (dispenser_action_index);
CREATE        INDEX destination_id         ON dispenses (destination_id);
CREATE        INDEX get_coin_id            ON dispenses (get_coin_id);
CREATE        INDEX get_tick_id            ON dispenses (get_tick_id);
CREATE        INDEX give_coin_id           ON dispenses (give_coin_id);
CREATE        INDEX give_tick_id           ON dispenses (give_tick_id);
CREATE        INDEX status_id              ON dispenses (status_id);
