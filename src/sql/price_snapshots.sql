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

CREATE TABLE price_snapshots (
    id                  BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    round_number        BIGINT NOT NULL,
    coin_pair           VARCHAR(20) NOT NULL,
    price               VARCHAR(40),
    reference_block     BIGINT NOT NULL DEFAULT 0,
    reference_chain     VARCHAR(10) NOT NULL DEFAULT 'BTC',
    block_timestamp     BIGINT NOT NULL DEFAULT 0,
    validator_count     INT NOT NULL,
    consensus_round     INT DEFAULT 1,
    consensus_proof     TEXT NOT NULL,
    status              ENUM('finalized','skipped','disputed') NOT NULL,
    source_chain        VARCHAR(10) NOT NULL DEFAULT 'DOGE',  -- which chain carried the PRICE v0 tx; mirrored from the hub so a reorg row:deleted (keyed on source_chain + source_action_index) can be applied to this copy. See xchain-hub/src/sql/price_snapshots.sql.
    source_action_index BIGINT,                                -- action_index of the PRICE tx on source_chain (NULL for hub-finalized); the reorg-retraction key (RETRACTION_COLUMNS.price_snapshots in hub_db_sync.js).
    push_generation     BIGINT NOT NULL DEFAULT 0,     -- source-chain reorg fence (item 5308); mirrored from the hub. See xchain-hub/src/sql/price_snapshots.sql.
    batch_block_time    BIGINT NOT NULL DEFAULT 0,     -- clock of the block the PRICE batch carrying this round LANDED in; 0 = no landed batch known yet (a round finalized over P2P and mirrored ahead of its batch). Stamped by the hub's batch ingest and mirrored from it, so a hub-connected node and a chain-only node can agree on which rounds the chain could have shown them. Read by getLatestPrice under price_fee_batch_landed_activation.js.
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_round_pair (round_number, coin_pair),
    KEY idx_pair_block (coin_pair, reference_block),
    KEY idx_pair_timestamp (coin_pair, block_timestamp),
    KEY idx_status (status),
    KEY idx_source_chain (source_chain),
    -- Oracle snapshot preload: WHERE status + reference_block range, ORDER BY round_number DESC.
    KEY idx_status_block_round (status, reference_block, round_number),
    -- The same preload once its consensus-time bound is active (see
    -- src/oracle_preload_causality_activation.js). Off the reference chain the
    -- reference_block range matches every row, so the time column has to lead the
    -- index for that bound to be a range scan instead of a filter over every
    -- finalized row.
    KEY idx_status_timestamp_round (status, block_timestamp, round_number),
    -- Fee pricing once the landed-batch bound is armed (see
    -- src/price_fee_batch_landed_activation.js): getLatestPrice selects one pair,
    -- bounds batch_block_time and then orders by round_number, so the landing clock
    -- has to sit between them or the added bound degrades into a filter over every
    -- finalized round of the pair.
    KEY idx_pair_batchtime_round (coin_pair, batch_block_time, round_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
