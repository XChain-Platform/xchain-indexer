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

DROP TABLE IF EXISTS links;
CREATE TABLE links (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    coin1_id            BIGINT UNSIGNED,          -- id of record in index_coins table
    coin1_action_index  BIGINT UNSIGNED,          -- action_index on coin1 network
    coin2_id            BIGINT UNSIGNED,          -- id of record in index_coins table
    coin2_action_index  BIGINT UNSIGNED,          -- action_index on coin2 network
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON links (action_index);
CREATE        INDEX coin1_id           ON links (coin1_id);
CREATE        INDEX coin1_action_index ON links (coin1_action_index);
CREATE        INDEX coin2_id           ON links (coin2_id);
CREATE        INDEX coin2_action_index ON links (coin2_action_index);
CREATE        INDEX memo_id            ON links (memo_id);
CREATE        INDEX status_id          ON links (status_id);
