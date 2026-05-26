DROP TABLE IF EXISTS contracts;
CREATE TABLE contracts (
    action_index          BIGINT UNSIGNED NOT NULL,
    source_id             BIGINT UNSIGNED NOT NULL,
    code                  MEDIUMTEXT NOT NULL,
    code_hash             CHAR(64) NOT NULL,
    api_version           INT UNSIGNED NOT NULL DEFAULT 1,
    status_id             BIGINT UNSIGNED,
    block_index           BIGINT UNSIGNED NOT NULL,
    cooldown_blocks       INT UNSIGNED,                    -- DEPLOY v1+: per-contract unstake cooldown (NULL = not stakeable)
    slash_destination_id  BIGINT UNSIGNED                  -- DEPLOY v1+: FK to index_addresses (BURN sentinel resolved at parse time; NULL = not stakeable)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index         ON contracts (action_index);
CREATE        INDEX source_id            ON contracts (source_id);
CREATE        INDEX code_hash            ON contracts (code_hash);
CREATE        INDEX status_id            ON contracts (status_id);
CREATE        INDEX slash_destination_id ON contracts (slash_destination_id);
