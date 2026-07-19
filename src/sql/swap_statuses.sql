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

DROP TABLE IF EXISTS swap_statuses;
CREATE TABLE swap_statuses (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (status of swap tx open/invalid/complete/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON swap_statuses (action_index);
CREATE        INDEX swap_action_index ON swap_statuses (swap_action_index);
-- Composite (status_id, action_index) bounds the per-block expiry sweep's
-- open-item probe: it filters swap_statuses by status_id (via the index_statuses
-- 'open' join) and needs action_index for the latest-status check, so the leading
-- column drives the join and the trailing column keeps it covering. Supersedes the
-- old single-column status_id index (leftmost-prefix), which is therefore dropped.
CREATE        INDEX status_action     ON swap_statuses (status_id, action_index);