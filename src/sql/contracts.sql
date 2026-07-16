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
    code                  MEDIUMTEXT NOT NULL,
    code_hash             CHAR(64) NOT NULL,
    api_version           INT UNSIGNED NOT NULL DEFAULT 1,
    status_id             BIGINT UNSIGNED,
    block_index           BIGINT UNSIGNED NOT NULL,
    cooldown_blocks       INT UNSIGNED,                    -- DEPLOY v1+: per-contract unstake cooldown (NULL = not stakeable)
    slash_destination_id  BIGINT UNSIGNED                  -- DEPLOY v1+: FK to index_addresses (BURN sentinel resolved at parse time — NULL means not stakeable)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index         ON contracts (action_index);
CREATE        INDEX source_id            ON contracts (source_id);
CREATE        INDEX code_hash            ON contracts (code_hash);
CREATE        INDEX status_id            ON contracts (status_id);
CREATE        INDEX slash_destination_id ON contracts (slash_destination_id);
