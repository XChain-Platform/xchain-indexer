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

-- Consolidated ATTEST action table. One row per ATTEST action_index, covering
-- all three version-discriminated phases of the external-data attestation
-- lifecycle (mirrors how `messages` holds every MESSAGE variant in one table):
--   version 0: Request  (VM-emitted via xchain.attestation.request)
--   version 1: Response (validator-broadcast PBFT bundle, verified sigs inlined as JSON)
-- A v0 request row and its v1 response row are separate rows correlated by
-- request_id (each ATTEST action keeps its own action_index). ATTEST v2 (expire)
-- is system-synthesized and only flips the v0 row's request_status; it writes no
-- row of its own, matching the pre-consolidation behavior.
--
-- The validator signatures that backed a v1 response live in `validator_signatures`
-- as a JSON array ([{"pubkey","sig"}, ...]) on the response row rather than in a
-- separate child table. Per-validator accountability tallies (fulfilled/missed/
-- slashed) live in `attest_validator_stats`, a cross-attestation rollup that can't
-- fold in here (its missed/slashed counts aren't derivable from response rows).
--
-- Spec: xchain-documentation/protocol/actions/ATTEST.md
DROP TABLE IF EXISTS attests;
CREATE TABLE attests (
    action_index                  BIGINT UNSIGNED NOT NULL,        -- FK to actions (the ATTEST action that wrote this row)
    version                       TINYINT UNSIGNED NOT NULL,       -- 0=request, 1=response (matches actions.action_format)
    request_id                    CHAR(64) NOT NULL,               -- correlation key across v0/v1 (SHA256(tx_hash:root_action_index:call_path:contract_index:emission_index))
    provider_id                   VARCHAR(32) NOT NULL,            -- e.g. 'http_get' (governance-registered)
    -- request (version 0) fields
    contract_index                BIGINT UNSIGNED,                 -- FK to contracts (which contract emitted the request)
    fee_payer_id                  BIGINT UNSIGNED,                 -- FK to index_addresses (original EXECUTE caller, billed for callback gas)
    payload                       MEDIUMTEXT,                      -- inlined request payload (URL for http_get, JSON envelope for llm)
    callback_method               VARCHAR(64),                     -- method on the contract to invoke on response
    callback_params_json          TEXT,                            -- developer-supplied params, echoed back to callback
    redundancy                    TINYINT UNSIGNED,                -- number of validator sigs required (1, 3, 5)
    deadline_block                BIGINT UNSIGNED,                 -- block beyond which the request times out
    gas_escrow                    VARCHAR(60),                     -- XCHAIN reserved for the callback EXECUTE
    fee_tick_id                   BIGINT UNSIGNED,                 -- FK to index_tickers (NULL = feeless; always the GAS tick in v1)
    fee_amount                    VARCHAR(60),                     -- request fee escrowed from fee_payer (NULL/0 = feeless)
    request_status                ENUM('pending','fulfilled','expired','errored','rejected'), -- lifecycle of the request (v0 rows only; 'rejected' = failed structural validation, never serviceable)
    resolved_block                BIGINT UNSIGNED,                 -- block at which request_status went terminal; the reorg-rollback reset key (v0 rows only)
    responsible_set_json          MEDIUMTEXT,                      -- v0: ordered responsible-set pubkeys (JSON array) pinned AS-OF block_index at request time (ATT-RECOMP-1); the reorg missed_count recompute reads this verbatim instead of re-deriving via getStakeWeightsByCapability (which sums the CURRENT mutable stakes.amount, corrupted by a surviving slash). NULL on legacy/rejected rows -> recompute falls back to the live re-derive.
    origin_chain                  VARCHAR(8),                      --  relay: on a BTC v3-materialized request, the origin chain (LTC/DOGE) it was emitted on; on an origin v0 request, that chain itself, which is what marks the row relay-eligible for the hub poll. NULL on every native single-chain request.
    origin_action_index           BIGINT UNSIGNED,                 --  relay: the origin chain's v0 action_index; the correlation key the response leg (ATTEST v4) relays back on
    -- response (version 1) fields
    response_hash                 CHAR(64),                        -- SHA256 of the canonical response body
    response_payload              MEDIUMTEXT,                      -- inlined response body
    response_status               ENUM('ok','timeout','no_quorum','provider_error','expired'),
    meta                          VARCHAR(256),                    -- opaque provider-defined metadata (e.g. http status, model id)
    validator_signatures          MEDIUMTEXT,                      -- JSON array of verified federation sigs: [{"pubkey","sig"}, ...]
    callback_execute_action_index BIGINT UNSIGNED,                 -- action_index of the system-injected EXECUTE that fired the callback
    -- common fields
    status_id                     BIGINT UNSIGNED,                 -- FK to index_statuses (action validation status)
    block_index                   BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    ON attests (action_index);
-- (request_id, version) is a NON-UNIQUE lookup index. A v0 request has exactly one row,
-- but the retry-then-ok response lifecycle (#4373) legitimately produces MULTIPLE v1 rows
-- for one request_id: each PBFT round (a retryable no_quorum/timeout/provider_error round,
-- then the terminal ok) is its own immutable, action-indexed on-chain action. A UNIQUE
-- (request_id, version) here rejected the later ok INSERT and stranded the request. Each v1
-- round is covered by the action-scoped consensus hash and rolled back by action_index, so
-- multiple rows stay deterministic and reorg-safe. v0 single-request integrity is enforced in
-- code (createAttestationRequest skips a duplicate v0 for an existing request_id). The
-- leftmost prefix still serves request_id-only lookups.
CREATE INDEX request_id_version ON attests (request_id, version);
--  relay: serves the hub's relay poll (relay-eligible pending v0 requests on an
-- origin chain) and the BTC side's origin-row resolution; both would otherwise scan.
CREATE        INDEX origin_chain_status ON attests (origin_chain, request_status, version);
--  relay identity (origin_chain, origin_action_index). Deliberately NON-UNIQUE: it
-- serves the v3 admission's exactly-once lookup (getRelayRequestByOrigin) as a seek instead
-- of a scan over every row this chain ever materialized from that origin. Uniqueness is
-- enforced in CODE, as a stored 'invalid' verdict, and must NOT be moved here: a rejected v3
-- persists its origin_chain/origin_action_index for the audit row, so two rejected v3s naming
-- one origin action would collide, and a UNIQUE violation THROWS mid-block inside a consensus
-- indexer rather than producing the identical stored verdict on every node ().
CREATE        INDEX origin_relay_identity ON attests (origin_chain, origin_action_index);
CREATE        INDEX version_status  ON attests (version, request_status, deadline_block);
CREATE        INDEX contract_index  ON attests (contract_index);
CREATE        INDEX provider_id     ON attests (provider_id);
CREATE        INDEX block_index     ON attests (block_index);
