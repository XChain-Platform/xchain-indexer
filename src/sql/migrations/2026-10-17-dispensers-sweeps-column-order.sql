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

-- xchain:migration mode=manual

ALTER TABLE dispensers
  MODIFY give_ownership TINYINT(1) NOT NULL DEFAULT 0 AFTER give_escrow,
  MODIFY fiat_id BIGINT UNSIGNED AFTER get_address_id,
  MODIFY fiat_amount VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci AFTER fiat_id,
  MODIFY oracle_address_id BIGINT UNSIGNED AFTER fiat_amount;

ALTER TABLE sweeps
  MODIFY orders BIGINT UNSIGNED AFTER ownerships,
  MODIFY swaps BIGINT UNSIGNED AFTER orders,
  MODIFY dispensers BIGINT UNSIGNED AFTER swaps;
