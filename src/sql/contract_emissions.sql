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

DROP TABLE IF EXISTS contract_emissions;
CREATE TABLE contract_emissions (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_index     BIGINT UNSIGNED NOT NULL,
    emitted_action      VARCHAR(20) NOT NULL,
    action_index        BIGINT UNSIGNED NULL,            -- the on-chain action this emission produced; NULL for internal emissions (e.g. SLASH) that move ledger state without minting a new on-wire action
    position            INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX execution_index ON contract_emissions (execution_index);
CREATE INDEX action_index    ON contract_emissions (action_index);
