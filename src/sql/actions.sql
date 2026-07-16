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

-- Table used to track individual actions within a transaction

DROP TABLE IF EXISTS actions;
CREATE TABLE actions (
  action_index  BIGINT UNSIGNED NOT NULL, -- Unique index for every action
  block_index   BIGINT UNSIGNED NOT NULL, -- block_index from the blocks table
  tx_index      BIGINT UNSIGNED,          -- tx_index from the transactions table
  tx_vout       BIGINT UNSIGNED,          -- transaction output index
  action_id     BIGINT UNSIGNED NOT NULL, -- id of record in index_actions table
  action_format TINYINT UNSIGNED,         -- FORMAT of action data (0-255)
  source_id     BIGINT UNSIGNED           -- id of record in index_addresses: the action's TRUE source (tx sender for user actions, contract address for emissions; NULL for system/synthetic actions). Authoritative for refunds/ownership/auth — never re-derive source from the transaction.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    on actions (action_index);
CREATE        INDEX block_index     on actions (block_index);
CREATE        INDEX tx_index        on actions (tx_index);
CREATE        INDEX action_id       on actions (action_id);
CREATE        INDEX action_format   on actions (action_format);
CREATE        INDEX source_id       on actions (source_id);