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

-- Table used to track individual transactions

DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
  tx_index    BIGINT UNSIGNED NOT NULL,
  block_index BIGINT UNSIGNED NOT NULL,
  tx_hash_id  BIGINT UNSIGNED NOT NULL, -- id of record in index_transactions table
  source_id   BIGINT UNSIGNED,          -- id of record in the index_addresses
  fee         BIGINT,                   -- miners fee in satoshis (copied from decoder)
  -- utf8mb4, not the table's utf8mb3 default: this holds the WHOLE decoded action
  -- string, so one legal 4-byte character anywhere in a broadcast (an emoji in a
  -- FILE name, a MEMO, a MESSAGE) made the INSERT fail 1366 and wedged the block loop.
  data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci -- decoded action string (copied from decoder)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX tx_index    on transactions (tx_index);
CREATE        INDEX block_index on transactions (block_index);
CREATE        INDEX tx_hash_id  on transactions (tx_hash_id);
CREATE        INDEX source_id   on transactions (source_id);
