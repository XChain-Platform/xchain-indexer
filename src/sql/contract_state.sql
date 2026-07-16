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

DROP TABLE IF EXISTS contract_state;
CREATE TABLE contract_state (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contract_index      BIGINT UNSIGNED NOT NULL,
    state_key           VARCHAR(256) NOT NULL,
    -- Binary-collation shadow of state_key: the armed state_key_collation
    -- reload (db.getContractState) groups by this column so the loose index
    -- scan on idx_latest_bin applies; GROUP BY state_key COLLATE utf8_bin
    -- cannot use the utf8_general_ci idx_latest and falls back to a filesort.
    state_key_bin       VARCHAR(256) CHARACTER SET utf8 COLLATE utf8_bin
                        GENERATED ALWAYS AS (state_key) VIRTUAL,
    state_value         MEDIUMTEXT,
    block_index         BIGINT UNSIGNED NOT NULL,
    action_index        BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Read current: SELECT ... WHERE contract_index=? AND state_key=? ORDER BY id DESC LIMIT 1
-- Rollback:     DELETE FROM contract_state WHERE block_index >= ?
CREATE INDEX idx_latest ON contract_state (contract_index, state_key, id DESC);
CREATE INDEX idx_block  ON contract_state (block_index);
CREATE INDEX idx_latest_bin ON contract_state (contract_index, state_key_bin, id DESC);
