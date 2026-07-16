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

-- xchain:migration mode=auto
-- Migration: allow NULL in the tick_id column of the five VM/staking detail
-- tables (deposits, withdrawals, contract_stakes, contract_unstakes,
-- contract_delegations).
--
-- WHY
-- ---
-- These handlers write their detail row even when the action is invalid, and
-- tick_id is resolved through createTicker(), which returns NULL for a TICK it
-- cannot resolve: an empty/absent TICK, or a wire ^<id> reference to a ticker id
-- that does not exist (e.g. a DEPOSIT to a contract whose tick was to be created
-- by a VM-emitted ISSUE that never ran). With NOT NULL on the column that write
-- throws ER_BAD_NULL_ERROR and the block-processing retry loop hard-wedges the
-- indexer on every node: the same fleet-halting liveness hole as the junk
-- contract-index rows (F-18, 2026-07-05 LTC-regtest sweep; contract_index made
-- nullable there). Found by the 2026-07-07 flag-day transition drill, where a
-- historical DEPOSIT carrying a ^<id> tick reference wedged both drill indexers
-- at block 396. Valid actions always carry a resolvable TICK, so NULL only ever
-- appears on invalid rows.
--
-- Additive + idempotent: MODIFY COLUMN to the same nullable definition is a
-- no-op on re-run; existing row values are untouched.

ALTER TABLE deposits             MODIFY COLUMN tick_id BIGINT UNSIGNED;
ALTER TABLE withdrawals          MODIFY COLUMN tick_id BIGINT UNSIGNED;
ALTER TABLE contract_stakes      MODIFY COLUMN tick_id BIGINT UNSIGNED;
ALTER TABLE contract_unstakes    MODIFY COLUMN tick_id BIGINT UNSIGNED;
ALTER TABLE contract_delegations MODIFY COLUMN tick_id BIGINT UNSIGNED;
