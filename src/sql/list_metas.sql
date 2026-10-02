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

DROP TABLE IF EXISTS list_metas;
CREATE TABLE list_metas (
    action_index      BIGINT UNSIGNED NOT NULL,
    list_action_index BIGINT UNSIGNED,
    name              VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    description       VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    memo_id           BIGINT UNSIGNED,
    status_id         BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON list_metas (action_index);
CREATE        INDEX list_action_index ON list_metas (list_action_index);
CREATE        INDEX memo_id           ON list_metas (memo_id);
CREATE        INDEX status_id         ON list_metas (status_id);
