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

DROP TABLE IF EXISTS file_completions;
CREATE TABLE file_completions (
    action_index          BIGINT UNSIGNED NOT NULL,
    manifest_action_index BIGINT UNSIGNED NOT NULL,
    result                ENUM('complete','mismatch') NOT NULL,
    block_index           BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON file_completions (action_index);
CREATE        INDEX manifest_action_index ON file_completions (manifest_action_index);
