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

DROP TABLE IF EXISTS sends;
CREATE TABLE sends (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id        BIGINT UNSIGNED,          -- id of record in index_ticks table
    destination_id BIGINT UNSIGNED,          -- id of record in index_addresses table
    amount         VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Amount of token in send
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index   ON sends (action_index);
CREATE        INDEX tick_id        ON sends (tick_id);
CREATE        INDEX destination_id ON sends (destination_id);
CREATE        INDEX status_id      ON sends (status_id);