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

DROP TABLE IF EXISTS bets;
CREATE TABLE bets (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    feed_action_index BIGINT UNSIGNED NOT NULL, -- action_index of the bet_feeds market this bet is placed on
    outcome           INT UNSIGNED,             -- Outcome index bet on (0..outcome count-1 of the feed)
    tick_id           BIGINT UNSIGNED,          -- id of record in index_tickers table (denormalized = feed wager tick)
    amount            VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- Stake escrowed at place time
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED,          -- id of record in index_statuses table (parse status of the place tx)
    bet_status_id     BIGINT UNSIGNED,          -- id of record in index_statuses table (current bet status:
                                                -- open/won/lost/refunded). Stored: the settlement pool predicate
                                                -- (SUM over bet_status='open' only) filters on it
    settled_block     BIGINT UNSIGNED           -- block_index of the terminal flip out of 'open' (NULL while open).
                                                -- In-place mutation stamp on a surviving row: keys the state-hash
                                                -- class, the reorg reset, and the sync updated_rows forward class
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index  ON bets (action_index);
-- Pool sums and the settlement scan drive off the feed: SUM(amount) WHERE
-- feed_action_index=? AND outcome=? AND bet_status='open', and the terminal
-- paths select WHERE feed_action_index=? AND bet_status='open' ORDER BY
-- action_index ASC. The leading column serves both.
CREATE        INDEX feed_outcome  ON bets (feed_action_index, outcome);
CREATE        INDEX bet_status_id ON bets (bet_status_id);
CREATE        INDEX settled_block ON bets (settled_block);
CREATE        INDEX tick_id       ON bets (tick_id);
CREATE        INDEX memo_id       ON bets (memo_id);
CREATE        INDEX status_id     ON bets (status_id);
