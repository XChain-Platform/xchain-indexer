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

DROP TABLE IF EXISTS cross_chain_call_rejections;
-- Node-local diagnostics for dispatch rows the XEXEC injection pass REFUSED
-- (XDISP-1: quorum-starved dispatches used to leave only a console.warn, so a
-- call that never gathers enough signer stake on this node's mirrored hub was
-- invisible to operators and to the hub's result poller).
--
-- One row per call_id, upserted on every refused injection attempt and DELETED
-- when the call finally executes (recordCrossChainCallExecution). This table is
-- observability ONLY: it never gates retry (a starved dispatch keeps re-checking
-- each block because different hubs hold different signature sets and a hub can
-- gossip more signatures later), it is not consensus state (signature sets are
-- per-hub, so nodes mirroring different hubs legitimately hold different rows),
-- it is never replicated (OPERATOR_LOCAL) and never rolled back (retries
-- repopulate it; a stale row after a reorg is deleted on eventual execution).
CREATE TABLE cross_chain_call_rejections (
    call_id     CHAR(64) NOT NULL PRIMARY KEY,          -- lowercase hex dispatch call id
    reason      VARCHAR(40) NOT NULL,                   -- refusal family (e.g. 'quorum_not_met')
    detail      VARCHAR(250),                           -- human-readable specifics (signer counts / stake tally)
    attempts    BIGINT UNSIGNED NOT NULL DEFAULT 1,     -- refused injection attempts so far
    first_block BIGINT UNSIGNED NOT NULL,               -- block of the first refused attempt
    last_block  BIGINT UNSIGNED NOT NULL                -- block of the most recent refused attempt
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX last_block ON cross_chain_call_rejections (last_block);
