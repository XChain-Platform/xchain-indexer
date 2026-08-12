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

-- Typed row for BET format 1 (cancel feed), the order_cancels / dispenser_cancels
-- pattern. Written for EVERY cancel action whatever its parse status, which is the
-- whole point of the table: before it existed a cancel wrote nothing but a
-- lifecycle history row, and only on the VALID path, so a chain-REJECTED cancel left
-- no status anywhere. The explorer served that action with a NULL status and the SDK
-- could only report statusKnown:false / statusSource:assumed - it could not tell a
-- rejection from a success. `status_id` here is the parse status ('valid' or
-- 'invalid: <reason>'); the FEED's lifecycle status stays in bet_feed_statuses.
DROP TABLE IF EXISTS bet_cancels;
CREATE TABLE bet_cancels (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index of the cancel action
    feed_action_index BIGINT UNSIGNED,          -- action_index from bet_feeds the cancel targeted. NULLABLE on purpose:
                                                -- an invalid cancel is stored too, and its wire may have named no feed
                                                -- at all (a NOT NULL column would reject that row and wedge the block)
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (parse status of the cancel tx:
                                                -- 'valid' or 'invalid: <reason>')
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON bet_cancels (action_index);
CREATE        INDEX feed_action_index ON bet_cancels (feed_action_index);
CREATE        INDEX memo_id           ON bet_cancels (memo_id);
CREATE        INDEX status_id         ON bet_cancels (status_id);
