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

DROP TABLE IF EXISTS withdrawals;
CREATE TABLE withdrawals (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,                -- NULL when the action is invalid with a non-numeric wire value (storage normalization)
    source_id           BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,                -- NULL when the action is invalid with an unresolvable TICK (e.g. a ^<id> ref to a non-existent tick); storage normalization, never on a valid row
    amount              VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON withdrawals (action_index);
CREATE        INDEX contract_index ON withdrawals (contract_index);
CREATE        INDEX source_id      ON withdrawals (source_id);
