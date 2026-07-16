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

DROP TABLE IF EXISTS xcalls;
CREATE TABLE xcalls (
    action_index          BIGINT UNSIGNED NOT NULL, -- the XCALL action row (v0 request or v2 expire), rollback-able
    version               INT             NOT NULL, -- 0 = request, 2 = expire
    call_id               VARCHAR(80)     NOT NULL, -- deterministic 64-hex id (see actions/xcall.js derivation)
    contract_index        BIGINT UNSIGNED,          -- requesting contract's DEPLOY action_index (v0 rows)
    target_chain          VARCHAR(10),
    target_contract_index BIGINT UNSIGNED,
    method                VARCHAR(64),
    params_json           TEXT,
    gas_limit             BIGINT UNSIGNED,
    cross_hops            INT,
    callback_method       VARCHAR(64),
    callback_params_json  TEXT,
    deadline_block        BIGINT UNSIGNED,          -- this-chain block height after which the request expires locally
    request_status        VARCHAR(20),              -- pending → completed | expired (the exactly-once callback interlock)
    result_status         VARCHAR(20),              -- outcome delivered to the callback (feeds xchain.crossChain.getCallResult)
    result_payload        TEXT,                     -- UTF-8 decoded return payload delivered to the callback
    resolved_block        BIGINT UNSIGNED,          -- block at which request_status went terminal (getCallResult visibility boundary)
    callback_action_index BIGINT UNSIGNED,          -- the injected callback EXECUTE's action_index
    block_index           BIGINT UNSIGNED NOT NULL,
    status_id             INT             NOT NULL  -- handler validation status (index_statuses)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON xcalls (action_index);
CREATE        INDEX call_id        ON xcalls (call_id);
CREATE        INDEX request_status ON xcalls (request_status, deadline_block);
CREATE        INDEX block_index    ON xcalls (block_index);
-- Source-contract lookup ("list cross-chain calls emitted by my contract") — used by the
-- explorer's getXcalls(type='contract') filter; without it that query is a full table scan.
CREATE        INDEX contract_index ON xcalls (contract_index);
