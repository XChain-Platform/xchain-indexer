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

DROP TABLE IF EXISTS list_items_invalid;
CREATE TABLE list_items_invalid (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    item_id      BIGINT UNSIGNED,           -- id of record (tick_id, address_id) tables
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_items_invalid (action_index);
CREATE        INDEX item_id      ON list_items_invalid (item_id);
CREATE        INDEX status_id    ON list_items_invalid (status_id);
