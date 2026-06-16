-- Consolidated ATTEST action table. One row per ATTEST action_index, covering
-- all three version-discriminated phases of the external-data attestation
-- lifecycle (mirrors how `messages` holds every MESSAGE variant in one table):
--   version 0 — Request  (VM-emitted via xchain.attestation.request)
--   version 1 — Response (validator-broadcast PBFT bundle, verified sigs inlined as JSON)
-- A v0 request row and its v1 response row are separate rows correlated by
-- request_id (each ATTEST action keeps its own action_index). ATTEST v2 (expire)
-- is system-synthesized and only flips the v0 row's request_status — it writes no
-- row of its own, matching the pre-consolidation behavior.
--
-- The validator signatures that backed a v1 response live in `validator_signatures`
-- as a JSON array ([{"pubkey","sig"}, ...]) on the response row rather than in a
-- separate child table. Per-validator accountability tallies (fulfilled/missed/
-- slashed) live in `attest_validator_stats` — a cross-attestation rollup that can't
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
    fee_payer_id                  BIGINT UNSIGNED,                 -- FK to index_addresses (original EXECUTE caller — billed for callback gas)
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
-- (request_id, version) is UNIQUE: with the per-root discriminator in the request_id preimage
-- (root_action_index — see attest.js/xcall.js) each v0 request and its v1 response carry a
-- collision-free request_id, so at most one row exists per (request_id, version). The constraint
-- turns any residual collision (e.g. an un-threaded emission path) into a loud INSERT failure
-- instead of a silent split-brain. Its leftmost prefix also serves request_id-only lookups.
CREATE UNIQUE INDEX request_id_version ON attests (request_id, version);
CREATE        INDEX version_status  ON attests (version, request_status, deadline_block);
CREATE        INDEX contract_index  ON attests (contract_index);
CREATE        INDEX provider_id     ON attests (provider_id);
CREATE        INDEX block_index     ON attests (block_index);
