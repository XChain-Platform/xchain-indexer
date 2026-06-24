-- Monotonic per-chain push generation, the source side of the reorg fence (item 5308).
-- Bumped once at the start of every rollback; stamped onto every hub push (oracle prices,
-- PRICE v0 rounds, and the XCALL/MATCH twins via the federation poll RPCs). A deferred
-- retraction carries the rollback's generation, and the hub deletes only rows whose
-- push_generation <= it, so a row re-published at a recycled action_index (higher generation)
-- survives. This table MUST NOT be a rollback dataTable/blockTable: it is monotonic across
-- reorgs, which is the entire point of the fence (a reset value would let the fence pass for
-- stale rows again).
CREATE TABLE push_generations (
    coin       VARCHAR(10)  NOT NULL,                -- BTC | LTC | DOGE
    generation BIGINT       NOT NULL DEFAULT 0,      -- monotonic; bumped per rollback, never decremented
    PRIMARY KEY (coin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
