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

-- Local mirror of the hub's oracle_prices table (user-published PRICE v1
-- oracle rows), populated by hub_db_sync. Schema mirrors
-- xchain-hub/src/sql/oracle_prices.sql so replicated rows land verbatim.
-- Without this file verifyTables() never creates the table and every
-- hub_db_sync oracle poll logs a 1146 against the single-host fallback DB
-- (price_snapshots had a schema file; oracle_prices was missed).
CREATE TABLE oracle_prices (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_address  VARCHAR(100) NOT NULL,        -- oracle operator's address (the SOURCE of the PRICE v1 tx)
    source_chain    VARCHAR(10)  NOT NULL,        -- chain on which the PRICE v1 tx was published
    coin            VARCHAR(10)  NOT NULL,        -- which chain's token this oracle is for (BTC/LTC/DOGE)
    tick            VARCHAR(50)  NOT NULL,        -- token name (e.g. PEPECASH)
    fiat            VARCHAR(10)  NOT NULL,        -- fiat currency code (e.g. USD, JPY)
    value           VARCHAR(250) NOT NULL,        -- price value as decimal string
    fee             VARCHAR(250),                 -- oracle usage fee as decimal (e.g. 0.01 = 1%)
    memo            VARCHAR(250),                 -- optional description from the oracle operator
    block_time      BIGINT UNSIGNED NOT NULL,     -- block_time of the publishing tx
    effective_at    BIGINT UNSIGNED NOT NULL,     -- when this price takes effect (block_time, or block_time+86400 for updates)
    action_index    BIGINT UNSIGNED NOT NULL,     -- action_index of the PRICE v1 tx on source_chain
    push_generation BIGINT NOT NULL DEFAULT 0,     -- source-chain reorg fence (item 5308); mirrored from the hub. A retraction deletes only rows with push_generation <= the rollback's generation, so a re-published row survives.
    -- ADMISSION HEIGHT, and deliberately ONE unsigned column rather than the per-chain map
    -- the signed rails carry (R5 (a), B13), mirrored from the hub
    -- (xchain-hub/src/sql/oracle_prices.sql). This row has no signatures and no canonical,
    -- so there is nothing to stamp a map into; the height is the PUBLISHING chain's, which
    -- source_chain already names, and the hub populates it from its own ingest of the PRICE
    -- v1 tx. The barrier certifies it against heights[oracle_prices][source_chain], not
    -- against the reading chain's own B, so every chain reads the row without a per-chain
    -- entry. effective_at stays the economic filter (the 24 h update window). NULL is the
    -- legacy row. Added by migrations/2026-09-16-admission-height.sql at this position.
    admit_block     BIGINT UNSIGNED DEFAULT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_oracle_action (source_chain, action_index),
    KEY idx_oracle_tick (source_address, coin, tick, fiat),
    KEY idx_effective   (coin, tick, fiat, effective_at),
    KEY idx_source_chain (source_chain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
