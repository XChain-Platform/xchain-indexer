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

-- Status history for bet_feeds (order_statuses pattern). Every row is caused by
-- a real action (create / cancel / resolve / BET_EXPIRE's minted action row), so
-- the table is action-scoped for streaming and rollback. The 'closed' latch
-- deliberately writes NO row here: it has no causing action, so a row for it
-- could neither stream forward nor roll back in the action-scoped model. The
-- latch's durable record is bet_feeds.closed_block (see bet_feeds.sql), and the
-- explorer synthesizes the 'closed' timeline entry from that stamp.
DROP TABLE IF EXISTS bet_feed_statuses;
CREATE TABLE bet_feed_statuses (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index of the causing action
    feed_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from bet_feeds table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (status of feed:
                                                -- open/resolved/resolved_void/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON bet_feed_statuses (action_index);
CREATE        INDEX feed_action_index ON bet_feed_statuses (feed_action_index);
CREATE        INDEX status_id         ON bet_feed_statuses (status_id);
