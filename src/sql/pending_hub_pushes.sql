DROP TABLE IF EXISTS pending_hub_pushes;
CREATE TABLE pending_hub_pushes (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    push_type           VARCHAR(32) NOT NULL,                     -- 'price_round' (PRICE v0) | 'oracle_price' (PRICE v1)
    action_index        BIGINT UNSIGNED NOT NULL,                 -- source PRICE action; lets a reorg purge queued pushes for orphaned actions
    payload             TEXT NOT NULL,                            -- JSON args for the hub JSON-RPC call
    attempts            INT UNSIGNED NOT NULL DEFAULT 0,          -- delivery attempts made so far
    last_attempted_at   DATETIME NULL,                           -- time of most recent attempt (NULL = not yet tried by poller)
    last_error          VARCHAR(500),                            -- last failure message (diagnostics only)
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending | failed  (delivered rows are deleted)
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX status       ON pending_hub_pushes (status);
CREATE INDEX push_type    ON pending_hub_pushes (push_type);
CREATE INDEX action_index ON pending_hub_pushes (action_index);
CREATE INDEX created_at   ON pending_hub_pushes (created_at);
