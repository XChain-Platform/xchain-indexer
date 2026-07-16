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

DROP TABLE IF EXISTS tokens;
CREATE TABLE tokens (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick_id            BIGINT UNSIGNED,                      -- id of record in index_ticks table
    action_index       BIGINT UNSIGNED,                      -- action_index of first ISSUE transaction (used in rollbacks)
    last_action_index  BIGINT UNSIGNED,                      -- action index of last  ISSUE transaction
    supply             VARCHAR(250),                         -- Current supply
    max_supply         VARCHAR(250),                         -- Maximum Supply
    max_mint           VARCHAR(250),                         -- Supply minted
    decimals           TINYINT(2),                           -- 0=non-divisible, 1-18=divisible
    description        VARCHAR(250),                         -- token description, or a URL to a TIS JSON document (Token Information Standard); not an icon URL
    lock_max_supply    TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MAX_SUPPLY
    lock_mint          TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MINT
    lock_mint_supply   TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MINT_SUPPLY
    lock_max_mint      TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MAX_MINT
    lock_description   TINYINT(1) NOT NULL DEFAULT 0,        -- Locks DESCRIPTION
    lock_sleep         TINYINT(1) NOT NULL DEFAULT 0,        -- Locks SLEEP
    lock_callback      TINYINT(1) NOT NULL DEFAULT 0,        -- Locks CALLBACK_BLOCK/TICK/AMOUNT
    callback_block     BIGINT UNSIGNED,                     -- block_index after which CALLBACK cand be used
    callback_tick_id   BIGINT UNSIGNED,                     -- id of record in index_tickers table
    callback_amount    VARCHAR(250),                         -- AMOUNT users get if CALLBACK
    allow_list         BIGINT UNSIGNED,                     -- action_index of list in lists table
    block_list         BIGINT UNSIGNED,                     -- action_index of list in lists table
    mint_address_max   VARCHAR(250),                         -- Maximum amount of supply an address can MINT
    mint_start_block   BIGINT UNSIGNED,                     -- block_index when MINT transactions are allowed (begin mint)
    mint_stop_block    BIGINT UNSIGNED,                     -- BLOCK_INDEX when MINT transactions are NOT allowed (end mint)
    owner_id              BIGINT UNSIGNED,                  -- id of record in index_addresses table
    escrow_action_index   BIGINT UNSIGNED DEFAULT NULL,     -- action_index of ORDER/SWAP/DISPENSER holding ownership in escrow (NULL = ownership not escrowed)
    coin_price            VARCHAR(250) NOT NULL default 0,  -- last  price of 1 token in native coin (BTC, LTC, DOGE, etc)
    coin_floor            VARCHAR(250) NOT NULL default 0   -- floor price of 1 token in native coin (BTC, LTC, DOGE, etc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX tick_id              ON tokens (tick_id);
CREATE        INDEX owner_id             ON tokens (owner_id);
CREATE        INDEX escrow_action_index  ON tokens (escrow_action_index);
CREATE        INDEX lock_max_supply  ON tokens (lock_max_supply);
CREATE        INDEX lock_mint        ON tokens (lock_mint);
CREATE        INDEX lock_max_mint    ON tokens (lock_max_mint);
CREATE        INDEX lock_mint_supply ON tokens (lock_mint_supply);
CREATE        INDEX lock_description ON tokens (lock_description);
CREATE        INDEX lock_sleep       ON tokens (lock_sleep);
CREATE        INDEX lock_callback    ON tokens (lock_callback);
CREATE        INDEX callback_tick_id ON tokens (callback_tick_id);
CREATE        INDEX allow_list       ON tokens (allow_list);
CREATE        INDEX block_list       ON tokens (block_list);
CREATE        INDEX action_index     ON tokens (action_index);
