DROP TABLE IF EXISTS prices;
CREATE TABLE prices (
    action_index        BIGINT UNSIGNED NOT NULL,         -- FK to actions table
    version             TINYINT UNSIGNED NOT NULL,        -- 0=validator snapshot, 1=user oracle
    source_id           BIGINT UNSIGNED NOT NULL,         -- FK to index_addresses (tx source)
    -- v0 fields (validator COIN/FIAT snapshot)
    round_number        BIGINT UNSIGNED,                  -- BTC block height of round
    round_timestamp     BIGINT UNSIGNED,                  -- block_time of triggering BTC block
    pair_count          SMALLINT UNSIGNED,                -- number of COIN/FIAT pairs
    pairs_json          TEXT,                             -- JSON array [{pair, price}, ...]
    sig_count           SMALLINT UNSIGNED,                -- number of PBFT signatures
    sigs_json           TEXT,                             -- JSON array [{pubkey, sig}, ...]
    -- v1 fields (user oracle TOKEN/FIAT)
    coin_id             BIGINT UNSIGNED,                  -- FK to index_coins (which chain's token)
    tick_id             BIGINT UNSIGNED,                  -- FK to index_tickers (token name)
    fiat_id             BIGINT UNSIGNED,                  -- FK to index_fiats (currency code)
    value               VARCHAR(250),                     -- price as decimal string
    fee                 VARCHAR(250),                     -- oracle usage fee as decimal
    memo_id             BIGINT UNSIGNED,                  -- FK to index_memos
    -- shared fields
    validation_status   VARCHAR(20) NOT NULL DEFAULT 'pending',  -- valid/invalid/pending (PBFT signature validation result for v0)
    status_id           BIGINT UNSIGNED                   -- FK to index_statuses (action status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON prices (action_index);
CREATE        INDEX version           ON prices (version);
CREATE        INDEX source_id         ON prices (source_id);
CREATE        INDEX round_number      ON prices (round_number);
CREATE        INDEX tick_id           ON prices (tick_id);
CREATE        INDEX fiat_id           ON prices (fiat_id);
CREATE        INDEX validation_status ON prices (validation_status);
