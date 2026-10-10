-- xchain:migration mode=auto

CREATE TABLE IF NOT EXISTS bet_edits (
    action_index      BIGINT UNSIGNED NOT NULL,
    feed_action_index BIGINT UNSIGNED,
    allow_list        BIGINT UNSIGNED,
    block_list        BIGINT UNSIGNED,
    memo_id           BIGINT UNSIGNED,
    status_id         BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX IF NOT EXISTS action_index      ON bet_edits (action_index);
CREATE        INDEX IF NOT EXISTS feed_action_index ON bet_edits (feed_action_index);
CREATE        INDEX IF NOT EXISTS allow_list        ON bet_edits (allow_list);
CREATE        INDEX IF NOT EXISTS block_list        ON bet_edits (block_list);
CREATE        INDEX IF NOT EXISTS memo_id           ON bet_edits (memo_id);
CREATE        INDEX IF NOT EXISTS status_id         ON bet_edits (status_id);
