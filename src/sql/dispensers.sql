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

DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id       BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id       BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount        VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- Amount of GIVE_TICK to dispense when triggered (empty when give_ownership=1)
    give_escrow        VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- Amount of GIVE_TICK to escrow in dispenser (empty when give_ownership=1)
    give_ownership     TINYINT(1) NOT NULL DEFAULT 0, -- 1 = dispenser sells GIVE_TICK ownership (single-shot, GIVE_AMOUNT / GIVE_ESCROW must be empty)
    get_coin_id        BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id        BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount         VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- Amount required to trigger dispenser
    get_address_id     BIGINT UNSIGNED,          -- id of record in index_addresses table (dispenser address)
    fiat_id            BIGINT UNSIGNED,          -- id of record in index_fiats table
    fiat_amount        VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- amount of FIAT required to trigger a dispense (ignored when oracle_address_id is set)
    oracle_address_id  BIGINT UNSIGNED,          -- id of record in index_addresses (user oracle SOURCE address - PRICE v1)
    expiration         BIGINT UNSIGNED,          -- unix timestamp of dispenser expiration date/time
    allow_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (status of open dispenser tx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;


CREATE UNIQUE INDEX action_index   ON dispensers (action_index);
CREATE        INDEX give_coin_id   ON dispensers (give_coin_id);
CREATE        INDEX give_tick_id   ON dispensers (give_tick_id);
CREATE        INDEX get_coin_id    ON dispensers (get_coin_id);
CREATE        INDEX get_tick_id    ON dispensers (get_tick_id);
CREATE        INDEX get_address_id ON dispensers (get_address_id);
CREATE        INDEX fiat_id           ON dispensers (fiat_id);
CREATE        INDEX oracle_address_id ON dispensers (oracle_address_id);
CREATE        INDEX allow_list     ON dispensers (allow_list);
CREATE        INDEX block_list     ON dispensers (block_list);
CREATE        INDEX memo_id        ON dispensers (memo_id);
CREATE        INDEX status_id      ON dispensers (status_id);
CREATE        INDEX give_ownership ON dispensers (give_ownership);
