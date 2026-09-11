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
    amount       VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,              -- Amount of token to destroy
    memo_id      BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id    BIGINT UNSIGNED,          -- id of record in index_statuses table
    leg_ordinal  SMALLINT UNSIGNED NOT NULL DEFAULT 0 -- 0-based position of this leg on the wire, stamped by createDestroy
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Non-unique, matching `sends`: a multi-destroy (DESTROY FORMAT 1/2) burns several
-- TICK legs under ONE action_index and each leg is its own row here. Under the
-- former UNIQUE index every leg after the first collided and was folded into the
-- first leg's row by createDestroy's UPDATE, so an N-tick destroy recorded 1
-- destruction. The leg identity is (action_index, tick_id, memo_id); the parse
-- consolidates by TICK|MEMO before any row is written, so it cannot repeat.
-- A multi-destroy's legs have no other stored position: without leg_ordinal a reader
-- either sorts on a value column (which contradicts the transaction) or takes whatever
-- order the engine hands back, which SQL guarantees nothing about. The composite index
-- serves the ordered read (ORDER BY on the same action_index the WHERE pins) from the
-- index rather than a filesort; the single-column index stays for the other queries.
CREATE        INDEX action_index   ON destroys (action_index);
CREATE        INDEX action_leg     ON destroys (action_index, leg_ordinal);
CREATE        INDEX tick_id        ON destroys (tick_id);
CREATE        INDEX memo_id        ON destroys (memo_id);
CREATE        INDEX status_id      ON destroys (status_id);

