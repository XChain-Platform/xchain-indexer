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

DROP TABLE IF EXISTS files;
CREATE TABLE files (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    -- utf8mb4: file names and titles are free-form user content, so a 4-byte character
    -- is legal. Both are 1000-byte keys once indexed, under the DYNAMIC 3072-byte limit.
    name                VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- File Name (filename.ext)
    title               VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- File Title (My Spreadsheet)
    type_id             BIGINT UNSIGNED,          -- id of record in index_mime_types table
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON files (action_index);
CREATE        INDEX type_id      ON files (type_id);
CREATE        INDEX memo_id      ON files (memo_id);
CREATE        INDEX status_id    ON files (status_id);
CREATE        INDEX name         ON files (name);