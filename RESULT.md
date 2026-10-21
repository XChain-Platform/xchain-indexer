# Lane report: cx-xc-5955

## Files touched
- src/db/database/instance_state.js: exactU64 helper, u64TypeCast pool typeCast (LONGLONG columns named expiration, deadline, allow_list, block_list, refund_window, expire_at), wired into connectionPoolParams, both exported.
- src/db/dispensers/index.js, src/db/orders/order_info.js, src/db/swaps/swap_info.js: info readers and edit overlays use exactU64 for EXPIRATION, ALLOW_LIST, BLOCK_LIST (NULL still reads 0 as before).
- src/db/coinpays/index.js, src/db/orders/cross_chain_offers.js: expiration via exactU64.
- src/db/bets/index.js: DEADLINE, REFUND_WINDOW, EXPIRE_AT, ALLOW_LIST, BLOCK_LIST via exactU64 (NULL preserved).
- src/api/rpc/token_policy.js: getappliedpolicy allow_list and block_list via exactU64.
- src/db/lists/rematch.js, src/api/rpc/orders.js: reviewed, no change needed (rematch compares String(value) and Number(value) === 0, both correct for an exact string; orders.js only handles the page limit and passes through already-exact rows).

## Parity
exactU64 returns the same Number as the old bigIntAsNumber read for every value up to 2^53 and differs only above it (exact string instead of a rounded Number). Replay parity is therefore unchanged for all ordinary values; a chain value above 2^53 would now compare and hash exactly, which is the intended fix. I did not run a replay parity run (no chain data here). If such values exist in replayed history, ride the change on a protocol_changes.js activation.

## Tests
- Targeted unit/regression/security files touching these readers (67 files): 643 passing, 2 failing. The 2 failures are environmental (missing sibling xchain-sync checkout and xchain-vm package), not related to this change.
- Full `npm test` cannot load here: xchain-vm readonly accessors are not installed.

## Not done / for the orchestrator
- The MariaDB integration test (store 18446744073709551615 and assert getDispenserInfo, orderFromRow, token_policy and orders RPCs) was NOT written or run: no MariaDB server in this session, and a test file lives under test/, outside Surfaces. Needs a follow-up row with a test/integration surface.
- The orders RPC needs no code change of its own; its offers come from cross_chain_offers.js, where allow_list/block_list already pass through the typeCast and expiration now uses exactU64.
- Downstream JS code comparing these fields numerically must tolerate a string above 2^53 (bc/bignumber helpers do).

RUN-COMPLETE 0085e7dd3b74ba291246db30c6db0b89
