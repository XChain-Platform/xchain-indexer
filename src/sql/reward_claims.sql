DROP TABLE IF EXISTS reward_claims;
CREATE TABLE reward_claims (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,
    amount              VARCHAR(250) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON reward_claims (action_index);
CREATE        INDEX source_id    ON reward_claims (source_id);
CREATE        INDEX status_id    ON reward_claims (status_id);
