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

DROP TABLE IF EXISTS addresses;
CREATE TABLE addresses (
    action_index         BIGINT UNSIGNED NOT NULL, -- Unique action index
    fee_preference       BIGINT UNSIGNED,
    require_memo         BIGINT UNSIGNED,
    dispenser_preference BIGINT UNSIGNED,          -- 1=Only owner can open dispenser (default), 2=Anyone
    memo_id              BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id            BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON addresses (action_index);
CREATE        INDEX memo_id        ON addresses (memo_id);
CREATE        INDEX status_id      ON addresses (status_id);