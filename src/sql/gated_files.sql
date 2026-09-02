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
    gate_ticker         VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,    -- Token ticker that gates this file
    encryption_method   TINYINT UNSIGNED NOT NULL,-- 1 = AES-256-GCM
    key_hash            CHAR(64) NOT NULL,        -- hex sha256(K), groups pack members
    -- Publisher-scoped unlock: the publishing SOURCE, and the unlock threshold.
    --
    -- publisher_address is NOT bookkeeping. A "pack" is keyed
    -- (publisher_address, gate_ticker, key_hash), not the older
    -- (gate_ticker, key_hash), because gate_ticker and key_hash are BOTH public on
    -- chain: without the publisher in the key, one publisher's files could join
    -- another's pack and move its effective threshold (the pack minimum), or force
    -- it unconditional. Publication is issuer-restricted today (actions/file.js
    -- rejects a non-issuer SOURCE), so the exposure is not open to outsiders, but
    -- tick ownership TRANSFERS: without this column a former issuer's files and the
    -- current issuer's files silently share one pack.
    publisher_address   VARCHAR(255) NOT NULL DEFAULT '', -- FILE SOURCE (pack scoping)
    -- Minimum GATE_TICKER balance a recipient must hold to be given the key. NULL or
    -- empty = unconditional. VARCHAR(40) matches the SDK's wire bound exactly: the
    -- wire rejects anything longer so this column can never truncate a valid value
    -- and make consensus validity depend on the DB's mode.
    gate_min_amount     VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
    status_id           BIGINT UNSIGNED,          -- id of record in index_statuses table
    raw_data            MEDIUMBLOB                -- Ciphertext bytes (mirrored from decoder for serving)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index             ON gated_files (action_index);
CREATE        INDEX gate_ticker_key_hash     ON gated_files (gate_ticker, key_hash);
CREATE        INDEX gate_ticker_status_id    ON gated_files (gate_ticker, status_id);
-- Pack lookup key (PC-29): the SEND threshold check resolves packs by
-- (publisher_address, gate_ticker, key_hash), so index it in that order.
CREATE        INDEX gated_files_pack         ON gated_files (publisher_address, gate_ticker, key_hash);
