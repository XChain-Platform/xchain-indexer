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

-- Typed row for BET format 3 (resolve feed), the sibling of bet_cancels and the same
--  reason: the resolve leg is stored for EVERY resolve action whatever its parse
-- status, so a chain-REJECTED resolve (wrong oracle, pre-deadline, out-of-range
-- OUTCOME, refund window already expired) persists a readable status instead of
-- vanishing. `outcome` is the winning outcome the oracle CLAIMED; on an invalid row it
-- is the un-honoured wire value and settles nothing. `status_id` is the parse status;
-- the FEED's lifecycle status stays in bet_feed_statuses.
DROP TABLE IF EXISTS bet_resolves;
CREATE TABLE bet_resolves (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index of the resolve action
    feed_action_index BIGINT UNSIGNED,          -- action_index from bet_feeds the resolve targeted. NULLABLE for the
                                                -- same reason as bet_cancels: invalid rows are stored, and their wire
                                                -- may have named no feed at all
    outcome           INT UNSIGNED,             -- Outcome index the oracle resolved to (0-based, un-honoured when invalid)
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (parse status of the resolve tx:
                                                -- 'valid' or 'invalid: <reason>')
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON bet_resolves (action_index);
CREATE        INDEX feed_action_index ON bet_resolves (feed_action_index);
CREATE        INDEX memo_id           ON bet_resolves (memo_id);
CREATE        INDEX status_id         ON bet_resolves (status_id);
