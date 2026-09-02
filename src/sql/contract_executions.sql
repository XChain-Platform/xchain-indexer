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

DROP TABLE IF EXISTS contract_executions;
CREATE TABLE contract_executions (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,                -- NULL when the action is invalid with a non-numeric wire value (storage normalization)
    caller_id           BIGINT UNSIGNED NOT NULL,
    method_name         VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
    input_params        TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
    gas_used            BIGINT UNSIGNED NOT NULL,
    gas_limit           BIGINT UNSIGNED NOT NULL,
    status_id           BIGINT UNSIGNED NOT NULL,
    error_message       TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
    emitted_count       INT UNSIGNED NOT NULL DEFAULT 0,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON contract_executions (action_index);
CREATE        INDEX contract_index ON contract_executions (contract_index);
CREATE        INDEX caller_id      ON contract_executions (caller_id);
CREATE        INDEX block_index    ON contract_executions (block_index);
