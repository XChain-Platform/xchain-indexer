DROP TABLE IF EXISTS deploy_chunks;
CREATE TABLE deploy_chunks (
    action_index  BIGINT UNSIGNED NOT NULL,   -- the DEPLOYCHUNK action's own index (rollback key)
    source_id     BIGINT UNSIGNED NOT NULL,   -- deployer (FK to index_addresses); assembly is source-bound
    code_hash     CHAR(64) NOT NULL,          -- chunk-group id = sha256 of the assembled UTF-8 source
    chunk_index   INT UNSIGNED NOT NULL,      -- 0-based position within the group
    total_chunks  INT UNSIGNED NOT NULL,      -- declared group size
    code_part     MEDIUMTEXT NOT NULL,        -- one base64 slice of base64(code)
    block_index   BIGINT UNSIGNED NOT NULL,
    status_id     BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON deploy_chunks (action_index);
-- Non-unique: every DEPLOYCHUNK is stored (valid or invalid) so the explorer can
-- surface each chunk's status. The DEPLOY assembler reads only VALID chunks and,
-- if a deployer broadcasts the same (source, group, position) more than once,
-- deterministically takes the LOWEST action_index — so a duplicate (or an invalid
-- chunk) can never block a position from being filled by a valid earlier one.
CREATE        INDEX source_hash_chunk ON deploy_chunks (source_id, code_hash, chunk_index);
CREATE        INDEX code_hash         ON deploy_chunks (code_hash);
CREATE        INDEX source_id         ON deploy_chunks (source_id);
CREATE        INDEX status_id         ON deploy_chunks (status_id);
