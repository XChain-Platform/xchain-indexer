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

DROP TABLE IF EXISTS balances;
CREATE TABLE balances (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id BIGINT UNSIGNED, -- id of record in index_addresses
    tick_id    BIGINT UNSIGNED, -- id of record in index_tickers
    amount     VARCHAR(250)      -- AMOUNT of balance
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX tick_id ON balances (tick_id);
CREATE UNIQUE INDEX addr_tick ON balances (address_id, tick_id);