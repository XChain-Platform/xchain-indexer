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

DROP TABLE IF EXISTS dispenser_expires;
CREATE TABLE dispenser_expires (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_expires (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_expires (dispenser_action_index);
CREATE        INDEX status_id              ON dispenser_expires (status_id);