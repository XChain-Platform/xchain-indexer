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

DROP TABLE IF EXISTS file_manifests;
CREATE TABLE file_manifests (
    action_index BIGINT UNSIGNED NOT NULL,
    source_id    BIGINT UNSIGNED NOT NULL,
    file_hash    CHAR(64) NOT NULL,
    total_parts  INT UNSIGNED NOT NULL,
    total_bytes  INT UNSIGNED NOT NULL,
    status_id    BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON file_manifests (action_index);
