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

DROP TABLE IF EXISTS credits;
CREATE TABLE credits (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of credit
) ENGINE=InnoDB DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON credits (action_index);
CREATE INDEX address_id   ON credits (address_id);
CREATE INDEX tick_id      ON credits (tick_id);
