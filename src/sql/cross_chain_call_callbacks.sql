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

DROP TABLE IF EXISTS cross_chain_call_callbacks;
CREATE TABLE cross_chain_call_callbacks (
    action_index          BIGINT UNSIGNED NOT NULL, -- the callback EXECUTE's action_index (rollback-able), or the result-processing marker
    call_id               VARCHAR(80)     NOT NULL, -- the cross_chain_calls result this callback delivered
    result_status         VARCHAR(20)     NOT NULL, -- status delivered (or 'skipped:<reason>' when the interlock suppressed delivery)
    block_index           BIGINT UNSIGNED NOT NULL  -- block height at which the result row was processed
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One processed result per call on this chain (idempotency: the callback pass
-- skips a result already present here). Dropped on reorg by action_index.
CREATE UNIQUE INDEX call_id      ON cross_chain_call_callbacks (call_id);
CREATE        INDEX action_index ON cross_chain_call_callbacks (action_index);
CREATE        INDEX block_index  ON cross_chain_call_callbacks (block_index);
