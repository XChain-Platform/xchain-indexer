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

DROP TABLE IF EXISTS lists;
-- TODO : Convert type and edit fields to INTEGER UNSIGNED and force value to 0-9 (0=null)
CREATE TABLE lists (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    type                VARCHAR(1),                -- List type (1=TICK, 2=ASSET, 3=ADDRESS)
    edit                VARCHAR(1),                -- Edit action (1=ADD, 2=REMOVE)
    list_action_index   BIGINT UNSIGNED,          -- list action_index
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON lists (action_index);
CREATE        INDEX type              ON lists (type);
CREATE        INDEX edit              ON lists (edit);
CREATE        INDEX list_action_index ON lists (list_action_index);
CREATE        INDEX status_id         ON lists (status_id);



