# Lane report: cx-xc-5955

## Files touched
- src/db/database/instance_state.js: u64TypeCast pool typeCast (named u64 wire columns, string only when above 2^53-1), exactU64 helper, both exported
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/bets/index.js, src/db/orders/cross_chain_offers.js, src/api/rpc/token_policy.js: Number() on expiration, allow_list, block_list, deadline, refund_window replaced by exactU64
- src/db/lists/rematch.js and src/api/rpc/orders.js: no change needed (rematch compares String(value) of the row; the orders RPC passes offers from cross_chain_offers.js through)

## Tests
- node --check on all changed files: pass
- Direct node check: exactU64('18446744073709551615') and u64TypeCast on an unsafe BIGINT return the exact string; safe values still return Number: pass
- npm test: NOT RUN (mocha and node_modules absent in this session, no MariaDB). 0 pass, 0 fail, unverified.

## For the orchestrator
- The MariaDB integration test and the replay parity run are NOT done: test files are outside Surfaces and no database was available. They still need to be written and run.
- Behavior is byte-identical for every value at or below 2^53-1. For unsafe values the state now differs from old code (exact instead of rounded; allow_list/block_list ids and expiration compare differently), so such values need a protocol_changes.js activation (outside Surfaces) unless a parity run shows otherwise.
- Arithmetic or strict equality on a now-string EXPIRATION/ALLOW_LIST in downstream files outside Surfaces was not audited; relational comparisons coerce, strict ones would not.
- The typeCast is keyed on column name, so any other query returning an unsafe value under those names also gets a string.

RUN-COMPLETE d701ad87183012d6228e8bf1d14c565b
