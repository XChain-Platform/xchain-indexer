# Lane report: cx-xc-5955

## Files touched
- src/db/database/instance_state.js: added `exactBigInt` (pool `typeCast`: Number if safe integer, else exact decimal string; NULL stays null) and `exactU64` reader helper; both exported.
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/bets/index.js, src/db/orders/cross_chain_offers.js, src/api/rpc/token_policy.js: `Number(...)` on EXPIRATION / ALLOW_LIST / BLOCK_LIST / DEADLINE-type fields replaced by `exactU64(...)`.
- src/db/lists/rematch.js and src/api/rpc/orders.js: reviewed, no change needed (rematch compares via String(); the orders RPC passes rows from cross_chain_offers.js through).

## Tests
- No test commands could be run: node_modules is not installed and no MariaDB is available in this session. 0 passed, 0 failed, none executed.
- Only `node --check` on every changed file (all OK) and a node one-liner on the helpers: typeCast of '18446744073709551615' returns the string, '42' returns 42, NULL returns null, non-BIGINT falls through to `next()`; `exactU64('18446744073709551615')` returns the string, `exactU64(5)` returns 5.

## Not done / for the orchestrator
1. The MariaDB integration test named in the acceptance is NOT written: test/ is outside Surfaces. It needs to store EXPIRATION and ALLOW_LIST = 18446744073709551615 and assert getDispenserInfo, orderFromRow, the gettokenpolicy/getappliedpolicy RPCs and the orders RPC return '18446744073709551615'.
2. The replay parity run is NOT done, and the change is NOT gated. This is consensus-relevant: for any stored value above 2^53, old code read a rounded Number and new code reads the exact string, so block and state hashes can differ on such data. Values at or below 2^53 are unchanged. Either run a replay including such a value, or ride a protocol_changes.js activation; that file is outside Surfaces and was not touched.
3. The ALLOW_LIST in getTokenInfo (src/db/tokens, outside Surfaces) was not checked for its own Number() coercion; the gettokenpolicy RPC passes info.ALLOW_LIST through unchanged, so it is exact only if getTokenInfo is.
4. The typeCast is pool-wide (every BIGINT, not only the named columns); other readers outside Surfaces that assume Number for a BIGINT above 2^53 would now see a string. Chain-bounded columns never exceed 2^53.
5. Contract compliance: commits are under Surfaces only plus this file; no em-dashes.

RUN-COMPLETE 490b34d53024526093707be7e38acdc6
