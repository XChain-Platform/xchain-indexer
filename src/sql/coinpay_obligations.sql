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

DROP TABLE IF EXISTS coinpay_obligations;
CREATE TABLE coinpay_obligations (
    action_index     BIGINT UNSIGNED NOT NULL, -- ORDER_MATCH action_index that created this obligation
    payer_address_id BIGINT UNSIGNED NOT NULL, -- id of record in index_addresses table (coin-offering party)
    payee_address_id BIGINT UNSIGNED NOT NULL, -- id of record in index_addresses table (token-selling party GET_ADDRESS)
    coin_id          BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table (BTC/LTC/DOGE)
    coin_amount      VARCHAR(250) NOT NULL,    -- Native coin amount owed
    expiration       BIGINT UNSIGNED NOT NULL,  -- Unix timestamp at which obligation expires
    block_index      BIGINT UNSIGNED NOT NULL  -- Block height when obligation was created
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON coinpay_obligations (action_index);
CREATE        INDEX payer_address_id ON coinpay_obligations (payer_address_id);
CREATE        INDEX payee_address_id ON coinpay_obligations (payee_address_id);
CREATE        INDEX coin_id          ON coinpay_obligations (coin_id);
