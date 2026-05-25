DROP TABLE IF EXISTS attestation_requests;
CREATE TABLE attestation_requests (
    action_index           BIGINT UNSIGNED NOT NULL,        -- FK to actions (the ATTESTATION_REQUEST action that created this row)
    request_id             CHAR(64) NOT NULL,               -- SHA256(tx_hash || contract_index || emission_index)
    contract_index         BIGINT UNSIGNED NOT NULL,        -- FK to contracts (which contract emitted the request)
    fee_payer_id           BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (original EXECUTE caller — billed for callback gas)
    provider_id            VARCHAR(32) NOT NULL,            -- e.g. 'http_get' (governance-registered)
    payload                MEDIUMTEXT,                      -- inlined request payload (URL for http_get, JSON envelope for llm)
    callback_method        VARCHAR(64) NOT NULL,            -- method on the contract to invoke on response
    callback_params_json   TEXT,                            -- developer-supplied params, echoed back to callback
    redundancy             TINYINT UNSIGNED NOT NULL,       -- number of validator sigs required (1, 3, 5)
    deadline_block         BIGINT UNSIGNED NOT NULL,        -- block beyond which the request times out
    gas_escrow             VARCHAR(60) NOT NULL,            -- XCHAIN reserved for the callback EXECUTE
    request_status         ENUM('pending','fulfilled','expired','errored') NOT NULL DEFAULT 'pending',
    block_index            BIGINT UNSIGNED NOT NULL,
    status_id              BIGINT UNSIGNED                  -- FK to index_statuses (action validation status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    ON attestation_requests (action_index);
CREATE UNIQUE INDEX request_id      ON attestation_requests (request_id);
CREATE        INDEX contract_index  ON attestation_requests (contract_index);
CREATE        INDEX provider_id     ON attestation_requests (provider_id);
CREATE        INDEX status_deadline ON attestation_requests (request_status, deadline_block);
CREATE        INDEX block_index     ON attestation_requests (block_index);
