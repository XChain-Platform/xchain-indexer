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

DROP TABLE IF EXISTS markets;
CREATE TABLE markets (
    id                 INTEGER UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick1_id           BIGINT UNSIGNED,                 -- tick1 - id of record in index_tickers table
    tick1_price        VARCHAR(250) NOT NULL default 0, -- tick1 - last trade price
    tick1_bid          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price buyers are paying
    tick1_ask          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price sellers are accepting
    tick1_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick1 - Price exactly 24 hours ago
    tick1_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour high price
    tick1_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour low price
    tick1_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour percentage change
    tick1_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour volume
    tick2_id           BIGINT UNSIGNED,                 -- tick2 - id of record in index_tickers table
    tick2_price        VARCHAR(250) NOT NULL default 0, -- tick2 - last trade price
    tick2_bid          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price buyers are paying
    tick2_ask          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price sellers are accepting
    tick2_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick2 - Price exactly 24 hours ago
    tick2_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour high price
    tick2_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour low price
    tick2_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour percentage change
    tick2_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour volume
    last_updated  BIGINT UNSIGNED                       -- Last updated
) ENGINE=InnoDB CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX tick1_id on markets (tick1_id);
CREATE INDEX tick2_id on markets (tick2_id);
-- One row per traded pair. Guarantees createMarket() can never produce two rows
-- for the same (tick1_id, tick2_id) even if inserts race, so market_id is stable.
CREATE UNIQUE INDEX uq_markets_pair on markets (tick1_id, tick2_id);