# Lane report: cx-xc-5955

## Files touched
src/db/database/instance_state.js (typeCast `u64WireTypeCast` on the pool, `u64Value` reader helper), src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/orders/cross_chain_offers.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/bets/index.js, src/api/rpc/token_policy.js.

Not changed: src/db/lists/rematch.js (already compares via String(value), which is exact once the reader returns the string) and src/api/rpc/orders.js (only clamps the page size; offers pass through offerFromRow).

## Behaviour
Columns named expiration, deadline, allow_list, block_list of type BIGINT read back as the exact decimal string when above 2^53, otherwise as a Number. Values at or below 2^53 are bit-identical to before, so only previously rounded values change.

## Tests
- No test commands could be run: node_modules is not installed in this session (mocha loads fail with MODULE_NOT_FOUND) and no MariaDB is available. Pass 0 / fail 0, nothing counted.
- `node --check` passes on every touched file; a direct call of the typeCast and helper returned '18446744073709551615' for that input and plain Numbers for small values and null.

## For the orchestrator
- The MariaDB integration test and the replay parity run are NOT done. A test belongs under test/integration/, outside Surfaces, so I did not add it.
- Consensus: values above 2^53 now differ from old code (old rounded to 18446744073709552000). Block and state hashes are identical for every value at or below 2^53 only. If u64 values above that are in replay data, the change should ride a protocol_changes.js activation, which is outside Surfaces and not added.
- Outside Surfaces, still lossy: parseInt(data['ALLOW_LIST']) in src/db/tokens/token_writer.js:67 (write side), and getTokenInfo readers and any other consumer that still calls Number() on these columns.

RUN-COMPLETE 6b60c4bf5ebc6099bfa19b9a300e6c52
