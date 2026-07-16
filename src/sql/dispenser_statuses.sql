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

DROP TABLE IF EXISTS dispenser_statuses;
CREATE TABLE dispenser_statuses (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    cancelled_by_id        BIGINT UNSIGNED,          -- id of record in index_addresses table (address that triggered the cancel - NULL for non-cancel statuses or auto-expire)
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (status of order tx open/invalid/complete/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index           ON dispenser_statuses (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_statuses (dispenser_action_index);
CREATE        INDEX cancelled_by_id        ON dispenser_statuses (cancelled_by_id);
CREATE        INDEX status_id              ON dispenser_statuses (status_id);