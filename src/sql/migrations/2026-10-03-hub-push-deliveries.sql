-- xchain:migration mode=auto

CREATE TABLE IF NOT EXISTS hub_push_deliveries (
    push_id             BIGINT UNSIGNED NOT NULL,
    hub_address         VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts            INT UNSIGNED NOT NULL DEFAULT 0,
    last_attempted_at   DATETIME NULL,
    last_error          VARCHAR(500),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (push_id, hub_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX IF NOT EXISTS status ON hub_push_deliveries (status);
CREATE INDEX IF NOT EXISTS updated_at ON hub_push_deliveries (updated_at);
