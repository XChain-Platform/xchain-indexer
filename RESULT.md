# Lane report: cx-xc-5955

## Files touched
- src/db/database/instance_state.js: pool `typeCast` (u64TypeCast) plus exported `exactU64` helper
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/orders/cross_chain_offers.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/bets/index.js, src/api/rpc/token_policy.js: Number() conversions of u64 wire columns replaced by exactU64
- src/db/lists/rematch.js, src/api/rpc/orders.js: reviewed, no change needed (rematch compares String(value); the orders RPC passes row values through)

## Behaviour
BIGINT columns named expiration, effective_expiration, allow_list, block_list, deadline, expire_at read as a Number when a safe integer (identical to today) and as the exact decimal string above 2^53-1. Only values above 2^53-1 change, and those were previously rounded.

## Tests
- No test commands were run: the sandbox has no node_modules and no MariaDB. Only `node --check` on every touched file (all pass) and an inline check of the cast logic ('18446744073709551615' stays exact, '42' stays 42).
- The MariaDB integration test and the replay parity run were NOT written or executed. A new test file lies outside Surfaces.

## For the orchestrator
- Consensus: for values above 2^53-1 old and new code differ (old rounded to 18446744073709552000-ish, new is exact), so hashes will differ on such a value. Per the acceptance this needs either a parity run showing it never occurs or a protocol_changes.js activation. protocol_changes.js is outside Surfaces and not touched; a follow-up must decide.
- src/db/orders/cross_chain_offer_lists.js (outside Surfaces) still does `Number(edit[field])` and will round an edit-overlaid allow_list/block_list above 2^53; it needs the same exactU64 change.
- Other readers of these columns outside Surfaces (for example getTokenInfo) now receive the exact string from the pool and may still Number() it.
- Strings flowing into JS arithmetic or `+` comparisons of EXPIRATION against block_time should be audited in a follow-up.

RUN-COMPLETE bf994663e2813fa6d3d8a2c0aad6009c
