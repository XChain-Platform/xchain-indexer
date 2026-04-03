DROP TABLE IF EXISTS delegations;
CREATE TABLE delegations (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    status_id           BIGINT UNSIGNED,                 -- active/revoked
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON delegations (action_index);
CREATE        INDEX source_id         ON delegations (source_id);
CREATE        INDEX signing_pubkey_id ON delegations (signing_pubkey_id);
CREATE        INDEX status_id         ON delegations (status_id);
