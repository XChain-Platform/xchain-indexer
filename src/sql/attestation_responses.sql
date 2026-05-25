DROP TABLE IF EXISTS attestation_responses;
CREATE TABLE attestation_responses (
    action_index                  BIGINT UNSIGNED NOT NULL,  -- FK to actions (the ATTESTATION_RESPONSE action)
    request_id                    CHAR(64) NOT NULL,         -- joins to attestation_requests.request_id
    provider_id                   VARCHAR(32) NOT NULL,
    response_hash                 CHAR(64) NOT NULL,         -- SHA256 of the canonical response body
    response_payload              MEDIUMTEXT,                -- inlined response body
    response_status               ENUM('ok','timeout','no_quorum','provider_error','expired') NOT NULL,
    meta                          VARCHAR(256),              -- opaque provider-defined metadata (e.g. http status, model id)
    callback_execute_action_index BIGINT UNSIGNED,           -- action_index of the system-injected EXECUTE that fired the callback
    block_index                   BIGINT UNSIGNED NOT NULL,
    status_id                     BIGINT UNSIGNED            -- FK to index_statuses (action validation status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON attestation_responses (action_index);
CREATE        INDEX request_id   ON attestation_responses (request_id);
CREATE        INDEX provider_id  ON attestation_responses (provider_id);
CREATE        INDEX block_index  ON attestation_responses (block_index);
