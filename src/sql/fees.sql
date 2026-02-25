DROP TABLE IF EXISTS fees;
CREATE TABLE fees (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id        BIGINT UNSIGNED,          -- id of record in index_tickers (default = GAS) 
    amount         VARCHAR(250),              -- Amount of TICK
    method         BIGINT UNSIGNED NOT NULL, -- FEE Payment Method (1=Destroy, 2=Donate)
    destination_id BIGINT UNSIGNED           -- id of record in index_addresses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON fees (action_index);
CREATE        INDEX tick_id        ON fees (tick_id);
CREATE        INDEX destination_id ON fees (destination_id);

