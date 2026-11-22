-- xchain:migration mode=auto
-- Migration: index price_snapshots (coin_pair, status, block_timestamp).
--
-- WHY
-- ---
-- The explorer's oracle price-history read (src/db/readers/wallet_reads/price_history.js)
-- filters coin_pair IN (..) AND status = 'finalized' AND block_timestamp in a range, then
-- groups by pair and time bucket. The pair-led key (coin_pair, block_timestamp) cannot see
-- status, so every round in the range costs a clustered-index lookup to test it (1.3 to 7.9 s
-- on regtest). With status between the pair and the timestamp, the equality prefix and the
-- range both resolve inside the index and the rows arrive in (pair, timestamp) order.
--
-- price is the fourth column so the `price IS NOT NULL` test is answered from the index and
-- the read never touches the clustered rows (a covering, index-only scan).
--
-- Additive and idempotent (ADD INDEX IF NOT EXISTS); the InnoDB secondary-index build is
-- INPLACE and does not block DML. No query text changes, so results are identical.
ALTER TABLE `price_snapshots`
    ADD INDEX IF NOT EXISTS `price_snapshots_pair_status_ts` (`coin_pair`, `status`, `block_timestamp`, `price`);
