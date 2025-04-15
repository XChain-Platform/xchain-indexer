DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    source_id        BIGINT UNSIGNED,          -- id of record in index_addresses (source/origin)
    address_id       BIGINT UNSIGNED,          -- id of record in index_addresses
    dispense_tick_id BIGINT UNSIGNED,          -- id of record in index_tickers table
    dispense_amount  VARCHAR(250),              -- Tokens to vend per dispense
    escrow_amount    VARCHAR(250),              -- Tokens to escrow in dispenser
    trigger_tick_id  BIGINT UNSIGNED,          -- id of record in index_tickers table
    trigger_amount   VARCHAR(250),              -- Amount required to trigger a dispense
    allow_list_id    BIGINT UNSIGNED,          -- id of record in index_transactions table
    block_list_id    BIGINT UNSIGNED,          -- id of record in index_transactions table
    action           BIGINT UNSIGNED,          -- Dispenser action (0=Open, 1=Refill, 2=Close, 3=List Edit)
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED,          -- id of record in index_statuses table
    -- State fields
    status           BIGINT UNSIGNED,          -- dispenser status (1=Open, 2=Closing, 3=Closed)    
    escrow_remaining VARCHAR(250)               -- Tokens escrowed in the dispensers (state field)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON dispensers (action_index);
CREATE        INDEX source_id        ON dispensers (source_id);
CREATE        INDEX address_id       ON dispensers (address_id);
CREATE        INDEX dispense_tick_id ON dispensers (dispense_tick_id);
CREATE        INDEX trigger_tick_id  ON dispensers (trigger_tick_id);
CREATE        INDEX allow_list_id    ON dispensers (allow_list_id);
CREATE        INDEX block_list_id    ON dispensers (block_list_id);
CREATE        INDEX action           ON dispensers (action);
CREATE        INDEX memo_id          ON dispensers (memo_id);
CREATE        INDEX status_id        ON dispensers (status_id);
CREATE        INDEX status           ON dispensers (status);