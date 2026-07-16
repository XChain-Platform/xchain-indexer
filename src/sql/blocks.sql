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

DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    block_index       BIGINT UNSIGNED,
    block_time        BIGINT UNSIGNED,
    ledger_hash_id    BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of credits/debits/escrow/balances data)
    actions_hash_id   BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of actions data)
    contract_hash_id  BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of contract data)
    state_hash_id     BIGINT UNSIGNED   -- id of record in index_transactions table (sha256 of in-place mutations + backdated credits; replication-integrity only, see stateHash.js)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX block_index       ON blocks (block_index);
CREATE INDEX ledger_hash_id    ON blocks (ledger_hash_id);
CREATE INDEX actions_hash_id   ON blocks (actions_hash_id);
CREATE INDEX contract_hash_id  ON blocks (contract_hash_id);
CREATE INDEX state_hash_id     ON blocks (state_hash_id);
