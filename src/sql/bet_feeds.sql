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

DROP TABLE IF EXISTS bet_feeds;
CREATE TABLE bet_feeds (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    -- utf8mb4: market title and outcome labels are free-form user content, so a 4-byte
    -- character is legal. Neither is indexed, and 250+1100 chars at 4 bytes stays far
    -- inside the 65535-byte row limit.
    label          VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Feed label (market title)
    outcomes       VARCHAR(1100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Canonical comma-joined outcome labels (trimmed, no surrounding whitespace)
    tick_id        BIGINT UNSIGNED,          -- id of record in index_tickers table (wager token)
    fee            VARCHAR(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Oracle fee as a PERCENT of the total pot (2dp; '1.00' = 1%)
    deadline       BIGINT UNSIGNED,          -- unix timestamp betting closes / earliest resolve (64-bit per Y2038 discipline)
    refund_window  BIGINT UNSIGNED,          -- seconds after deadline the oracle has to resolve
    expire_at      BIGINT UNSIGNED,          -- materialized deadline + refund_window; computed and range-checked at parse
                                             -- (the expiry-pass predicate is not indexable without it)
    min_amount     VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,             -- Minimum stake per bet (NULL = none)
    allow_list     BIGINT UNSIGNED,          -- action_index of a list from the lists table (only members may bet)
    block_list     BIGINT UNSIGNED,          -- action_index of a list from the lists table (members may NOT bet; block wins)
    -- utf8mb4: nominally base64, but the value is stored as it landed on the wire with
    -- no charset validation, so a 4-byte character reaches the column on an invalid feed.
    details        TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Market definition JSON, base64 as landed on the wire (NULL = none)
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id      BIGINT UNSIGNED,          -- id of record in index_statuses table (parse status of the create tx)
    feed_status_id BIGINT UNSIGNED,          -- id of record in index_statuses table (current feed lifecycle status:
                                             -- open/closed/resolved/resolved_void/cancelled/expired). Stored, not derived:
                                             -- the bounded latch/expiry passes index on it
    closed_block   BIGINT UNSIGNED,          -- block_index that latched the feed closed (NULL until latched). In-place
                                             -- mutation stamp: keys the state-hash class, the reorg reset, and the
                                             -- sync updated_rows forward class (polls.resolved_block pattern)
    terminal_block BIGINT UNSIGNED           -- block_index of the terminal flip (resolved/resolved_void/cancelled/expired;
                                             -- NULL while open/closed). Same stamp discipline as closed_block
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON bet_feeds (action_index);
CREATE        INDEX tick_id        ON bet_feeds (tick_id);
CREATE        INDEX allow_list     ON bet_feeds (allow_list);
CREATE        INDEX block_list     ON bet_feeds (block_list);
CREATE        INDEX memo_id        ON bet_feeds (memo_id);
CREATE        INDEX status_id      ON bet_feeds (status_id);
-- The two bounded per-block passes drive off these composites: the latch step
-- scans (feed_status='open', deadline <= BLOCK_TIME) ordered deadline ASC, the
-- expiry step scans (feed_status IN open/closed, expire_at <= BLOCK_TIME)
-- ordered expire_at ASC. Without them each pass is a full-table scan per block
-- whose cost an attacker sets by creating feeds.
CREATE        INDEX status_deadline ON bet_feeds (feed_status_id, deadline);
CREATE        INDEX status_expire   ON bet_feeds (feed_status_id, expire_at);
-- Stamp columns are range-scanned by the state-hash class (BETWEEN block, block),
-- the rollback resets (>= block), and the sync updated_rows window queries.
CREATE        INDEX closed_block   ON bet_feeds (closed_block);
CREATE        INDEX terminal_block ON bet_feeds (terminal_block);
