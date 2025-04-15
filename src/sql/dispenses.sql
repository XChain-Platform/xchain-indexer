DROP TABLE IF EXISTS dispenses;
CREATE TABLE dispenses (
    action_index    BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispense_index  BIGINT UNSIGNED, 
    source_id       BIGINT UNSIGNED,          -- id of record in index_addresses (dispenser address)
    destination_id  BIGINT UNSIGNED,          -- id of record in index_addresses (purchasing address)
    tick_id         BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount          VARCHAR(250),              -- Tokens to vend per dispense
    trigger_tick_id BIGINT UNSIGNED,          -- id of record in index_tickers table
    trigger_amount  VARCHAR(250),              -- Amount of trigger_tick_id paid in this dispense
    status_id       BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON dispenses (action_index);
CREATE        INDEX source_id        ON dispenses (source_id);
CREATE        INDEX destination_id   ON dispenses (destination_id);
CREATE        INDEX tick_id          ON dispenses (tick_id);
CREATE        INDEX trigger_tick_id  ON dispenses (trigger_tick_id);
CREATE        INDEX status_id        ON dispenses (status_id);
