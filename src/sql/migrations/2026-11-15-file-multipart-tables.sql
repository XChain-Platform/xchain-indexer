-- xchain:migration mode=auto

CREATE TABLE IF NOT EXISTS file_manifests (
    action_index BIGINT UNSIGNED NOT NULL,
    source_id    BIGINT UNSIGNED NOT NULL,
    file_hash    CHAR(64) NOT NULL,
    total_parts  INT UNSIGNED NOT NULL,
    total_bytes  INT UNSIGNED NOT NULL,
    status_id    BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index ON file_manifests (action_index);

CREATE TABLE IF NOT EXISTS file_parts (
    action_index BIGINT UNSIGNED NOT NULL,
    source_id    BIGINT UNSIGNED NOT NULL,
    file_hash    CHAR(64) NOT NULL,
    part_index   INT UNSIGNED NOT NULL,
    byte_length  INT UNSIGNED NOT NULL,
    part_digest  CHAR(64) NOT NULL,
    block_index  BIGINT UNSIGNED NOT NULL,
    status_id    BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index           ON file_parts (action_index);
CREATE        INDEX IF NOT EXISTS source_hash_part_index ON file_parts (source_id, file_hash, part_index);

CREATE TABLE IF NOT EXISTS file_completions (
    action_index          BIGINT UNSIGNED NOT NULL,
    manifest_action_index BIGINT UNSIGNED NOT NULL,
    result                ENUM('complete','mismatch') NOT NULL,
    block_index           BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index ON file_completions (action_index);
