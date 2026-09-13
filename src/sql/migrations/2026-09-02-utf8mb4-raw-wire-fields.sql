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
--
-- Migration: widen the GRAMMAR-CONSTRAINED raw wire fields from utf8mb3 to utf8mb4.
--
-- WHY
-- ---
-- The 2026-08-19 utf8mb4 pass widened the free-form text columns and left two groups
-- behind: contracts.code and the grammar-constrained raw fields. Both were still
-- wedge-capable, because an action that FAILS validation is persisted anyway: every action
-- family calls its create* writer after computing the status string, with the wire fields
-- exactly as they arrived. A METHOD, a QUORUM, a COIN tag or a contract's source rejected
-- by the parser is INSERTed verbatim into a utf8mb3 column, where a 4-byte character fails
-- errno 1366 (ER_TRUNCATED_WRONG_VALUE_FOR_FIELD) under STRICT_TRANS_TABLES. The block
-- loop retries the block forever, so one transaction halts every indexer on the chain at
-- the same height, for the price of a single fee.
--
-- The NUMERIC members of the set (amounts, values, fees, block heights, lock flags) are
-- widened as defence in depth rather than as live wedges: db.normalizeDataValues nulls a
-- non-numeric NUMBER_FIELDS / LOCK_FIELDS entry before the INSERT, so those store NULL
-- today instead of halting. That hand-maintained list is the only thing standing between
-- them and the same errno 1366, and it has already failed exactly this way once
-- (CONTRACT_ACTION_INDEX, the 2026-07-05 LTC-regtest wedge). After this file the columns
-- hold the bytes whatever the list says.
--
-- The columns are listed in src/utf8mb4Columns.js, which is the ONE definition the three
-- paths share: the src/sql/<table>.sql definitions (fresh installs), this migration (aged
-- origin DBs), and the xchain-sync replica widen (followers, which run no migrations).
-- That module also records what stays excluded and why - notably index_addresses.address,
-- whose consensus preimages pin `COLLATE utf8_bin` and so needs its own change.
--
-- Ingest semantics are unchanged: this widens the accepted byte domain and rewrites no
-- stored value. utf8mb3 is a strict subset of utf8mb4 and utf8mb4_general_ci orders BMP
-- characters exactly as utf8_general_ci does, so every existing row keeps its bytes and
-- its sort position.
--
-- NOT CONSENSUS-VISIBLE. Of the tables touched here only contract_executions enters a
-- block-hash preimage (db.getBlockHashes), and the preimage selects action_index,
-- contract_index, caller_address, gas_used, status and emitted_count - never
-- method_name / input_params / error_message - and orders by action_index alone. No
-- column here is compared against another column, so no join changes collation.
--
-- PAIRED FILE: the NOT NULL half of the same widen ships as
-- 2026-09-02-utf8mb4-raw-wire-fields-not-null.sql, tagged mode=manual. A MODIFY carrying
-- NOT NULL is indistinguishable from a narrowing to the auto-apply destructive-DDL
-- classifier (db._destructiveAutoStatement), and omitting NOT NULL is not an option: a
-- MODIFY restates the whole column, so it would silently relax it and diverge the two
-- schema paths. Until that file is applied, contracts.code and the NOT NULL amount
-- columns remain a halt vector.
--
-- IDEMPOTENT: re-running a MODIFY to the same type and charset is a no-op, and the
-- schema_migrations ledger records this file once per DB. Fresh installs already get
-- utf8mb4 from the src/sql/<table>.sql definitions, which the schema-parity suite holds
-- byte-equal to the MODIFYs below in both directions.
--
-- NOTE: a charset widen on a VARCHAR is a COPY rebuild under a shared metadata lock, not
-- ALGORITHM=INSTANT. Most tables here are small; sends, issues and orders dominate the
-- run on a mainnet DB. attests.provider_id and gated_files.gate_ticker carry secondary
-- indexes, whose keys grow to 128 and 1000 bytes respectively - both well inside the
-- 3072-byte InnoDB limit under ROW_FORMAT=DYNAMIC (the MariaDB 10.2+ default).
--
-- HOW TO RUN (it also applies unattended at startup)
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-02-utf8mb4-raw-wire-fields.sql

ALTER TABLE `broadcasts`
  MODIFY `value` VARCHAR(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `fee` VARCHAR(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `sends`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `mints`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `destroys`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `dividends`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `callbacks`
  MODIFY `callback_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `airdrops`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `issues`
  MODIFY `max_supply` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `max_mint` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `decimals` VARCHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `mint_supply` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_max_supply` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_mint` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_mint_supply` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_max_mint` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_description` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_sleep` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `lock_callback` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_block` VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `mint_address_max` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `mint_start_block` VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `mint_stop_block` VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `orders`
  MODIFY `give_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `get_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `swaps`
  MODIFY `give_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `get_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `dispensers`
  MODIFY `give_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `give_escrow` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `get_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `fiat_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `dispenser_edits`
  MODIFY `give_escrow` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `bets`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `bet_feeds`
  MODIFY `fee` VARCHAR(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `min_amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `sleeps`
  MODIFY `resume_block` VARCHAR(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `lists`
  MODIFY `type` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `edit` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `messages`
  MODIFY `coin` VARCHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `encryption_method` VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `votes`
  MODIFY `share` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `memo` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `polls`
  MODIFY `quorum` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `min_vote_balance` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `decide_threshold` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `deposit_amount` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `gas_escrow` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_method` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `contract_executions`
  MODIFY `method_name` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `input_params` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `error_message` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `prices`
  MODIFY `value` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `fee` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `gated_files`
  MODIFY `gate_min_amount` VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL;

ALTER TABLE `attests`
  MODIFY `payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_method` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_params_json` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `gas_escrow` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `fee_amount` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `response_payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `meta` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE `xcalls`
  MODIFY `method` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `params_json` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_method` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY `callback_params_json` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
