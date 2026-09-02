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

DROP TABLE IF EXISTS broadcasts;
CREATE TABLE broadcasts (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    -- utf8mb4: BROADCAST text is free-form user content, so a 4-byte character is legal.
    message                VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Message, oracle info, or feed info
    `value`                VARCHAR(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Numerical value of the broadcast
    fee                    VARCHAR(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Oracle / Feed usage  fee
    memo_id                BIGINT UNSIGNED,          -- id of record in index_memos table 
    broadcast_action_index BIGINT UNSIGNED,          -- broadcast action_index
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table

) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON broadcasts (action_index);
CREATE        INDEX broadcast_action_index ON broadcasts (broadcast_action_index);
CREATE        INDEX memo_id                ON broadcasts (memo_id);
CREATE        INDEX status_id              ON broadcasts (status_id);
