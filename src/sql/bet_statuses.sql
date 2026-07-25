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

-- Status history for bets (order_statuses pattern). Rows are caused by the
-- place tx ('open'), the resolve tx ('won'/'lost'), the cancel tx ('refunded'),
-- or BET_EXPIRE's minted action row ('refunded'); all action-scoped.
DROP TABLE IF EXISTS bet_statuses;
CREATE TABLE bet_statuses (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index of the causing action
    bet_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from bets table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table (status of bet:
                                               -- open/won/lost/refunded)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index     ON bet_statuses (action_index);
CREATE        INDEX bet_action_index ON bet_statuses (bet_action_index);
CREATE        INDEX status_id        ON bet_statuses (status_id);
