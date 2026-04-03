DROP TABLE IF EXISTS contracts;
CREATE TABLE contracts (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,
    code                MEDIUMTEXT NOT NULL,
    code_hash           CHAR(64) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON contracts (action_index);
CREATE        INDEX source_id    ON contracts (source_id);
CREATE        INDEX code_hash    ON contracts (code_hash);
CREATE        INDEX status_id    ON contracts (status_id);
