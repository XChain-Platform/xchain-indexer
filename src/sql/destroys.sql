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

DROP TABLE IF EXISTS destroys;
CREATE TABLE destroys (
    action_index BIGINT UNSIGNED NOT NULL, -- Action index (NOT unique: one row per multi-destroy leg)
    tick_id      BIGINT UNSIGNED,          -- id of record in index_ticks table
    amount       VARCHAR(250),              -- Amount of token to destroy
    memo_id      BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Non-unique, matching `sends`: a multi-destroy (DESTROY FORMAT 1/2) burns several
-- TICK legs under ONE action_index and each leg is its own row here. Under the
-- former UNIQUE index every leg after the first collided and was folded into the
-- first leg's row by createDestroy's UPDATE, so an N-tick destroy recorded 1
-- destruction. The leg identity is (action_index, tick_id, memo_id); the parse
-- consolidates by TICK|MEMO before any row is written, so it cannot repeat.
CREATE        INDEX action_index   ON destroys (action_index);
CREATE        INDEX tick_id        ON destroys (tick_id);
CREATE        INDEX memo_id        ON destroys (memo_id);
CREATE        INDEX status_id      ON destroys (status_id);

