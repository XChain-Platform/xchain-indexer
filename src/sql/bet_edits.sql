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

DROP TABLE IF EXISTS bet_edits;
CREATE TABLE bet_edits (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    feed_action_index BIGINT UNSIGNED,          -- action_index from bet_feeds; nullable for invalid edits
    allow_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table; 0 detaches
    block_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table; 0 detaches
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON bet_edits (action_index);
CREATE        INDEX feed_action_index ON bet_edits (feed_action_index);
CREATE        INDEX allow_list        ON bet_edits (allow_list);
CREATE        INDEX block_list        ON bet_edits (block_list);
CREATE        INDEX memo_id           ON bet_edits (memo_id);
CREATE        INDEX status_id         ON bet_edits (status_id);
