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

-- Table used to map action_indexes
-- Note : Used to pull a list of action_indexes related to an address or tick

DROP TABLE IF EXISTS mappings_actions;
CREATE TABLE mappings_actions (
    action_index  BIGINT  UNSIGNED NOT NULL, -- Action index
    type_id       TINYINT UNSIGNED,          -- Integer value for mapping type
                                             -- 1 = tick    (id=tick_id)
                                             -- 2 = address (id=address_id)
    id            BIGINT UNSIGNED NOT NULL   -- id of record
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON mappings_actions (action_index);
CREATE        INDEX type_id           ON mappings_actions (type_id);
CREATE        INDEX id                ON mappings_actions (id);
