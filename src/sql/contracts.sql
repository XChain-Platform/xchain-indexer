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

DROP TABLE IF EXISTS contracts;
CREATE TABLE contracts (
    action_index          BIGINT UNSIGNED NOT NULL,
    source_id             BIGINT UNSIGNED NOT NULL,
    code                  MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
    code_hash             CHAR(64) NOT NULL,
    api_version           INT UNSIGNED NOT NULL DEFAULT 1,
    status_id             BIGINT UNSIGNED,
    block_index           BIGINT UNSIGNED NOT NULL,
    cooldown_blocks       INT UNSIGNED,                    -- DEPLOY v1+: per-contract unstake cooldown (NULL = not stakeable)
    slash_destination_id  BIGINT UNSIGNED,                 -- DEPLOY v1+: FK to index_addresses (BURN sentinel resolved at parse time, NULL means not stakeable)
    -- CONTRACT_META_REQUIRED: the contract's own exported meta.name / meta.description /
    -- meta.version, plus the raw JSON the isolate serialized, extracted at deploy time.
    -- Written only for a valid deploy whose meta conforms; NULL on every other row, so an
    -- oversized value can never reach a column narrower than the byte rule. Explicitly
    -- utf8mb4 (the table default is utf8mb3) because these carry free-form author text.
    -- Not in any hash preimage: the contracts leg of contract_hash selects fixed columns.
    meta_name             VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
    meta_description      VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
    meta_version          VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
    meta_json             TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index         ON contracts (action_index);
CREATE        INDEX source_id            ON contracts (source_id);
CREATE        INDEX code_hash            ON contracts (code_hash);
CREATE        INDEX status_id            ON contracts (status_id);
CREATE        INDEX slash_destination_id ON contracts (slash_destination_id);
CREATE        INDEX source_code_hash     ON contracts (source_id, code_hash);

-- Contract meta search. FULLTEXT rather than a B-tree: the explorer finds a contract by a
-- WORD of its name or description, which no B-tree serves, and InnoDB's default minimum
-- token length (3) is the explorer's own minimum search term length.
CREATE FULLTEXT INDEX meta_search ON contracts (meta_name, meta_description);
