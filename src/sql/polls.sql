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

-- VOTE poll definitions. One row per VOTE v0 (create poll) action_index. The
-- poll's identity IS its creating action_index (no caller-supplied id), matching
-- how every other protocol object is keyed by its source action.
--
-- A poll is governed and decided by holders of one token (tick_id), which is both
-- the electorate and the weight basis. Ballots live in `votes`, one row per
-- (poll, voter, option). The finalization columns (winning_option ... onward) are
-- written by the system-injected VOTE v2 in Phase 2; Phase 1 leaves them null and
-- computes the tally lazily at read time (see db.getPollTally).
--
-- Spec: xchain-documentation/protocol/actions/VOTE.md
DROP TABLE IF EXISTS polls;
CREATE TABLE polls (
    action_index            BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v0 that created the poll); also the poll id
    block_index             BIGINT UNSIGNED NOT NULL,   -- creation block (rollback key)
    tick_id                 BIGINT UNSIGNED,            -- FK to index_tickers: electorate + weight token
    end_block               BIGINT UNSIGNED,            -- latest close block (voting accepted while cast_block <= end_block)
    -- utf8mb4: option labels are free-form user content, so a 4-byte character is legal.
    options                 MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- JSON array of option labels, index-addressed by ballots
    max_selections          SMALLINT UNSIGNED,          -- max distinct options one ballot may list (1 = single-choice)
    tally_mode              ENUM('approval','split'),   -- approval = full weight per option; split = weight divided by per-option shares
    weight_mode             ENUM('balance','stake','flat','quadratic','time_weighted'), -- balance = close holdings; flat = one-address-one-vote; quadratic = sqrt(close); time_weighted = windowed avg; stake reserved
    quorum                  VARCHAR(60),                -- optional weight gate: min (counted weight / close supply) fraction, e.g. '0.2'
    min_voters              BIGINT UNSIGNED,            -- optional participation gate: min distinct qualifying voters
    min_vote_balance        VARCHAR(60),                -- dust floor: a voter counts toward min_voters only if close balance >= this
    decide_threshold        VARCHAR(60),                -- optional early-decide arm: fraction of supply an option must reach (Phase 2)
    -- utf8mb4: inline question text is free-form user content (see options above).
    question                MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- inline question text or a FILE reference
    -- lifecycle
    poll_status             ENUM('open','finalized','failed_quorum') NOT NULL DEFAULT 'open', -- poll state (distinct from status_id)
    -- finalization (written by VOTE v2 in Phase 2; null until then)
    winning_option          SMALLINT UNSIGNED,          -- option index with highest weight (lowest index on tie); null if no winner
    total_weight            VARCHAR(60),                -- total counted weight at close
    total_voters            BIGINT UNSIGNED,            -- distinct qualifying voters at close
    quorum_met              TINYINT UNSIGNED,           -- 1 if weight quorum satisfied
    min_voters_met          TINYINT UNSIGNED,           -- 1 if participation gate satisfied
    fail_reason             ENUM('quorum','min_voters','both'), -- why a poll terminated failed_quorum (null when passed)
    decided_early           TINYINT UNSIGNED,           -- 1 if closed by decide_threshold before end_block
    effective_close_block   BIGINT UNSIGNED,            -- block weights were measured at (end_block, or early-decide crossing block)
    finalized_action_index  BIGINT UNSIGNED,            -- action_index of the VOTE v2 that finalized this poll
    resolved_block          BIGINT UNSIGNED,            -- block finalization went terminal; reorg-rollback reset key
    -- creation deposit (anti-spam): XCHAIN escrowed at v0, refunded to the creator
    -- on 'finalized' or forfeited to the DONATE1 treasury on 'failed_quorum' by v2
    deposit_amount          VARCHAR(60),                -- XCHAIN amount escrowed at creation (null/0 = none)
    deposit_address_id      BIGINT UNSIGNED,            -- FK to index_addresses: the creator who paid the deposit (refund target)
    deposit_resolved        ENUM('refunded','forfeited'), -- set by v2 finalization once the deposit is released
    -- binding poll / callback-on-finalize (optional; null = a signaling poll):
    -- v2 finalization fires CALLBACK_METHOD on CALLBACK_CONTRACT with the result,
    -- turning a decided poll into an on-chain effect (mirrors ATTEST's callback)
    callback_contract_index BIGINT UNSIGNED,            -- FK to contracts: the contract v2 invokes on finalization
    callback_method         VARCHAR(64),                -- method name on that contract
    callback_params         MEDIUMTEXT,                 -- JSON array of developer params echoed to the callback
    callback_on             ENUM('pass','always'),      -- pass = only on a finalized win; always = every finalization
    gas_escrow              VARCHAR(60),                -- XCHAIN escrowed at v0 to back the callback EXECUTE (refunded at finalize)
    callback_execute_action_index BIGINT UNSIGNED,      -- action_index of the EXECUTE v2 injected (set when fired)
    callback_delay_blocks   BIGINT UNSIGNED,            -- v0 CALLBACK_DELAY_BLOCKS timelock (honored at/after the VOTE_CALLBACK_TIMELOCK flag-day; null/0 = fire at finalize)
    callback_due_block      BIGINT UNSIGNED,            -- block the deferred callback fires (resolved_block + delay; stamped by v2, null = immediate)
    -- action validation
    status_id               BIGINT UNSIGNED             -- FK to index_statuses (validation status of the create action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON polls (action_index);
CREATE        INDEX tick_id      ON polls (tick_id);
CREATE        INDEX end_block    ON polls (end_block);
CREATE        INDEX poll_status  ON polls (poll_status, end_block);
CREATE        INDEX block_index  ON polls (block_index);
