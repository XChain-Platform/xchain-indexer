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

DROP TABLE IF EXISTS coinpay_expires;
CREATE TABLE coinpay_expires (
    action_index            BIGINT UNSIGNED NOT NULL, -- Unique action index of this COINPAY_EXPIRE action
    obligation_action_index BIGINT UNSIGNED NOT NULL, -- FK to coinpay_obligations (ORDER_MATCH action_index)
    status_id               BIGINT UNSIGNED            -- id of record in index_statuses table (valid/invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index            ON coinpay_expires (action_index);
CREATE        INDEX obligation_action_index ON coinpay_expires (obligation_action_index);
CREATE        INDEX status_id               ON coinpay_expires (status_id);
