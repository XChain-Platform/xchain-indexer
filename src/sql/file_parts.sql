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

DROP TABLE IF EXISTS file_parts;
CREATE TABLE file_parts (
    action_index BIGINT UNSIGNED NOT NULL,
    source_id    BIGINT UNSIGNED NOT NULL,
    file_hash    CHAR(64) NOT NULL,
    part_index   INT UNSIGNED NOT NULL,
    byte_length  INT UNSIGNED NOT NULL,
    part_digest  CHAR(64) NOT NULL,
    block_index  BIGINT UNSIGNED NOT NULL,
    status_id    BIGINT UNSIGNED,
    fill_ordinal INT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index             ON file_parts (action_index);
CREATE        INDEX source_hash_part_index   ON file_parts (source_id, file_hash, part_index);
CREATE        INDEX source_hash_fill_ordinal ON file_parts (source_id, file_hash, fill_ordinal);
