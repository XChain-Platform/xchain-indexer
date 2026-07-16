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

-- Gated FILE v1 metadata. One row per FILE v1 action with a non-empty
-- GATE_TICKER. Files sharing (gate_ticker, key_hash) form a "pack" that
-- unlocks atomically. See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
DROP TABLE IF EXISTS gated_files;
CREATE TABLE gated_files (
    action_index        BIGINT UNSIGNED NOT NULL, -- ACTION_INDEX of the gated FILE action
    gate_ticker         VARCHAR(250) NOT NULL,    -- Token ticker that gates this file
    encryption_method   TINYINT UNSIGNED NOT NULL,-- 1 = AES-256-GCM
    key_hash            CHAR(64) NOT NULL,        -- hex sha256(K), groups pack members
    status_id           BIGINT UNSIGNED,          -- id of record in index_statuses table
    raw_data            MEDIUMBLOB                -- Ciphertext bytes (mirrored from decoder for serving)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index             ON gated_files (action_index);
CREATE        INDEX gate_ticker_key_hash     ON gated_files (gate_ticker, key_hash);
CREATE        INDEX gate_ticker_status_id    ON gated_files (gate_ticker, status_id);
