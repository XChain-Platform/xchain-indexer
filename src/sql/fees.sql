DROP TABLE IF EXISTS fees;
CREATE TABLE fees (
    action_index        BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,                    -- FK to index_tickers (kept for future flexibility)
    amount              VARCHAR(250),                       -- Legacy: amount of TICK
    method              BIGINT UNSIGNED NOT NULL,           -- Legacy: FEE Payment Method (1=Destroy, 2=Donate)
    destination_id      BIGINT UNSIGNED,                    -- FK to index_addresses
    gas_cost            BIGINT UNSIGNED DEFAULT 0,          -- raw gas units (unified)
    gas_price           VARCHAR(250) DEFAULT '0',           -- GAS_PRICE at time of action (unified)
    xchain_amount       VARCHAR(250) DEFAULT '0',           -- gas * GAS_PRICE (unified)
    payment_mode        TINYINT UNSIGNED NOT NULL DEFAULT 2,-- 1=native_coin, 2=xchain_balance
    native_coin_amount  VARCHAR(250),                       -- null for XCHAIN balance payments (Track B)
    native_coin         VARCHAR(10),                        -- 'BTC', 'LTC', 'DOGE', or null (Track B)
    oracle_round        BIGINT UNSIGNED,                    -- price_snapshot round used, or null (Track B)
    fee_preference      TINYINT UNSIGNED NOT NULL DEFAULT 2,-- 1=burn, 2=protocol, 3=community, 4=buyback
    status_id           BIGINT UNSIGNED,
    fee_version         TINYINT UNSIGNED NOT NULL DEFAULT 1 -- 1=legacy, 2=unified gas
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON fees (action_index);
CREATE        INDEX tick_id        ON fees (tick_id);
CREATE        INDEX destination_id ON fees (destination_id);
CREATE        INDEX fee_version    ON fees (fee_version);
CREATE        INDEX payment_mode   ON fees (payment_mode);
