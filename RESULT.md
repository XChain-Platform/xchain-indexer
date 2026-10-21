# Lane report: cx-xc-5955

## Files touched
- src/db/database/instance_state.js: pool option supportBigNumbers (bigNumberStrings off) so only BIGINTs beyond 2^53 come back as exact decimal strings; new exported helper exactU64.
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/bets/index.js, src/db/orders/cross_chain_offers.js, src/api/rpc/token_policy.js: Number() on u64 wire fields replaced by exactU64 (row mappers and the edit overlays).
- src/db/lists/rematch.js, src/api/rpc/orders.js: reviewed, no change needed (they only compare via String() or pass rows through).

## Tests
- node --check on every changed file: pass.
- exactU64 spot check: '18446744073709551615' and 18446744073709551615n stay exact, '9007199254740993' stays a string, safe values and '007' become Numbers, null stays null.
- test/unit/db/db_session_timezone_utc.test.js and test/unit/chain/genesis_dump.test.js: 16 passing, 0 failing.
- Full unit suite and test/unit/db: NOT runnable here, 0 pass/0 fail counted. Mocha aborts at load with "xchain-vm readonly accessors resolve at neither src/readonly-accessors.js nor src/readonly_accessors.js" (the vendored xchain-vm directory is absent).
- MariaDB integration test: NOT written or run. No MariaDB server in this session, and a test file lies outside Surfaces. The acceptance test (store EXPIRATION and ALLOW_LIST = 18446744073709551615, assert getDispenserInfo, orderFromRow, token_policy and orders RPC return '18446744073709551615') still needs a follow-up row that may touch test/integration.
- Replay parity run: NOT run. By construction every value within Number.MAX_SAFE_INTEGER reads identically; only values above 2^53 change representation (rounded Number to exact string), so a replay containing one will differ in state-hash input unless gated.

## For the orchestrator
- protocol_changes.js is outside Surfaces, so no activation gate was added. Any replayed chain holding a u64 above 2^53 would diverge old vs new; decide whether this needs a gate before merge. Block validation already nulls values beyond the column, and EXPIRATION/list ids that large are compared only to small block times and list ids, so behavior should not change in practice.
- Outside Surfaces, still coercing with Number() and rounding: src/db/orders/cross_chain_offer_lists.js (edit overlay), src/db/issues/token_info.js and src/db/tokens/token_writer.js (parseInt of ALLOW_LIST), src/chain/genesis_dump.js (comment and normalizer assume bigIntAsNumber Numbers; may now see strings above 2^53). Needs a follow-up row.
- The pool option is global: any BIGINT above 2^53 anywhere now arrives as a string instead of a rounded Number.

RUN-COMPLETE 9e836e5d28a33e648ca282682baf6b81
