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

DROP TABLE IF EXISTS `sleeps`;
CREATE TABLE sleeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    type             BIGINT UNSIGNED,          -- 1=Address, 2=Ticker
    tick_id          BIGINT UNSIGNED,          -- id of record in index_tickers table
    resume_block     VARCHAR(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Block index of the resume block
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sleeps (action_index);
CREATE        INDEX type           ON sleeps (type);
CREATE        INDEX tick_id        ON sleeps (tick_id);
CREATE        INDEX memo_id        ON sleeps (memo_id);
CREATE        INDEX status_id      ON sleeps (status_id);

