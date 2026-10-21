# Lane report: cx-xc-5955

Base: 690b0c72367296f610da70a6b6a3072a2a72a0fe. Branch cloud/run-65d4529adce5 (the earlier lane/XC-5955 commits were not present in this checkout, so this was built from the base).

## Files touched (all inside Surfaces)
- src/db/database/instance_state.js: new `u64Column` helper; comment on the pool options updated. Pool options themselves (bigIntAsNumber) are NOT changed.
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/swaps/swap_info.js, src/db/coinpays/index.js, src/db/orders/cross_chain_offers.js, src/db/lists/rematch.js: u64 columns selected as CAST(col AS CHAR) and decoded with `u64Column`.
- src/db/bets/index.js: DEADLINE, REFUND_WINDOW, EXPIRE_AT cast; effective allow/block lists added as `*_list_exact` twins (original columns kept because test/unit/api/rpc/bets_effective_lists.test.js pins the original CASE text) and folded back into ALLOW_LIST/BLOCK_LIST.
- src/api/rpc/token_policy.js: getappliedpolicy decodes through `u64Column`.
- src/api/rpc/orders.js: no change needed; it passes the offers from cross_chain_offers.js through.

## Design and the review objection
The review said the pool-wide typeCast changes every BIGINT read. This round removes that: there is no pool or typeCast change. Only the named u64 wire columns change, per query. `u64Column` returns the same Number as before for any value a Number holds exactly (safe integer), and the exact decimal string only above 2^53, so every previously exact value keeps its type and value. Null still reads as 0 where Number(null) did. The state and block hashes are computed from the stored columns, which were always exact; only values above 2^53 read differently, and those read rounded before.

## Tests
- Targeted unit/regression/security files touching these readers (98 files): 913 passing, 1 pending, 1 failing. The failure is test/unit/bridge/escrow_journal_writer.test.js, ENOENT on /home/user/xchain-sync/src/state_commitment/index.js (sibling repo absent in this sandbox; unrelated to this change).
- Full `npm test` cannot start here: test/unit/attestation/db_get_attestation_data_for_vm.test.js throws at load because the vendored xchain-vm readonly accessors are absent.
- Ad hoc check (tmp/check.js, not committed): getDispenserInfo over a driver-shaped row with expiration/allow_list = '18446744073709551615' returns '18446744073709551615' for EXPIRATION and ALLOW_LIST, and 5 stays the Number 5.

## Not done, and why (needs the orchestrator)
1. MariaDB integration test: not written or run. No MariaDB exists in this sandbox (apt has no mariadb-server) and test/ is outside Surfaces, so a new test file would refuse the whole result. It needs a file such as test/integration/u64_wire_columns_exact.test.js that stores EXPIRATION and ALLOW_LIST = 18446744073709551615 in dispensers, orders and swaps and asserts getDispenserInfo, orderFromRow (via getOrderInfo), getSwapInfo and the RPCs return the string.
2. Replay parity run: not run (no MariaDB, no chain data here). Argument instead of proof: stored columns and hashes are untouched and values at or below 2^53 are byte-identical in type and value. A parity run over a fixture with a value above 2^53 should still be done before merge; if it shows any difference, the change must ride a protocol_changes.js activation, which is outside Surfaces.
3. gettokenpolicy (token_policy.js) still returns rounded ALLOW_LIST/BLOCK_LIST resolution inputs because getTokenInfo in src/db/issues/token_info.js (line 175 `arr['ALLOW_LIST'] = row.allow_list`) is outside Surfaces and reads the pool-rounded column. It needs the same CAST plus `u64Column` there. getappliedpolicy in token_policy.js is exact once token_info.js is fixed.
4. Other BIGINT u64 readers outside Surfaces (dispenser writes/dispense_matching, cross_chain_offer_lists.js) were not touched.

RUN-COMPLETE c0509c3e9d3bfdb702297493c1a5569e
