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

DROP TABLE IF EXISTS prices;
CREATE TABLE prices (
    action_index        BIGINT UNSIGNED NOT NULL,         -- FK to actions table
    version             TINYINT UNSIGNED NOT NULL,        -- 0=validator snapshot, 1=user oracle
    source_id           BIGINT UNSIGNED NOT NULL,         -- FK to index_addresses (tx source)
    -- v0 fields (validator COIN/FIAT snapshot); also carries the v2 BATCH row's anchor:
    -- round_number is set to FIRST_ROUND on a v2 row, since the column is indexed and
    -- every existing read treats it as "the round this action is about"
    round_number        BIGINT UNSIGNED,                  -- BTC block height of round (v2: FIRST_ROUND of the batch)
    round_timestamp     BIGINT UNSIGNED,                  -- block_time of triggering BTC block
    pair_count          SMALLINT UNSIGNED,                -- number of COIN/FIAT pairs (NULL on a v2 row; see rounds_json)
    pairs_json          TEXT,                             -- JSON array [{pair, price}, ...] (NULL on a v2 row; see rounds_json)
    sig_count           SMALLINT UNSIGNED,                -- number of PBFT signatures (NULL on a v2 row; see sigs_json)
    sigs_json           TEXT,                             -- JSON array [{pubkey, sig}, ...]; carries the BATCH signature set on a v2 row
    -- v2 fields (validator BATCH snapshot: one signed action carrying an hourly
    -- window of full round bodies). NULL on a v0/v1 row.
    batch_first_round   BIGINT UNSIGNED,                  -- FIRST_ROUND of the batch window (v2 only; NULL on a v0/v1 row)
    batch_last_round    BIGINT UNSIGNED,                  -- LAST_ROUND of the batch window (v2 only; NULL on a v0/v1 row)
    round_count         SMALLINT UNSIGNED,                -- number of rounds carried by this batch (v2 only)
    rounds_json         TEXT,                             -- JSON array of the batch per-round bodies [{round, timestamp, btc_block_height, pairs}, ...] (v2 only)
    -- v1 fields (user oracle TOKEN/FIAT)
    coin_id             BIGINT UNSIGNED,                  -- FK to index_coins (which chain's token)
    tick_id             BIGINT UNSIGNED,                  -- FK to index_tickers (token name)
    fiat_id             BIGINT UNSIGNED,                  -- FK to index_fiats (currency code)
    value               VARCHAR(250),                     -- price as decimal string
    fee                 VARCHAR(250),                     -- oracle usage fee as decimal
    memo_id             BIGINT UNSIGNED,                  -- FK to index_memos
    -- shared fields
    validation_status   VARCHAR(20) NOT NULL DEFAULT 'pending',  -- valid/invalid/pending (PBFT signature validation result for v0)
    status_id           BIGINT UNSIGNED                   -- FK to index_statuses (action status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON prices (action_index);
CREATE        INDEX version           ON prices (version);
CREATE        INDEX source_id         ON prices (source_id);
CREATE        INDEX round_number      ON prices (round_number);
CREATE        INDEX tick_id           ON prices (tick_id);
CREATE        INDEX fiat_id           ON prices (fiat_id);
CREATE        INDEX validation_status ON prices (validation_status);
