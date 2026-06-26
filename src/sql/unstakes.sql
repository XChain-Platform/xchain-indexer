DROP TABLE IF EXISTS unstakes;
CREATE TABLE unstakes (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (which stake is being unstaked)
    cooldown_end_block  BIGINT UNSIGNED NOT NULL,        -- block when funds release
    amount              VARCHAR(250) NOT NULL,           -- Total amount being unstaked (sum of all active stake rows for this pubkey at time of unstake)
    status_id           BIGINT UNSIGNED,                 -- pending/completed/cancelled
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON unstakes (action_index);
CREATE        INDEX source_id          ON unstakes (source_id);
CREATE        INDEX signing_pubkey_id  ON unstakes (signing_pubkey_id);
CREATE        INDEX status_id          ON unstakes (status_id);
CREATE        INDEX cooldown_end_block ON unstakes (cooldown_end_block);
-- Composite for the per-block cooldown sweep (status_id filter + cooldown_end_block range).
CREATE        INDEX status_cooldown    ON unstakes (status_id, cooldown_end_block);
