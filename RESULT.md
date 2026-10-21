# Lane report: cx-xc-6073

Files touched (this round):
- src/db/orders/order_info.js: EXPIRATION/ALLOW_LIST/BLOCK_LIST read via exactU64(value) ?? 0
- src/db/orders/cross_chain_offers.js: expiration read via exactU64(...) ?? 0
- bin/pins/at1-suite-titles.json: conflict with develop resolved (develop's pin plus this row's test file, +1 file, +3 titles in each of the 4 sections)

Cause of the gate failure: exactU64 maps NULL to null, while the old Number(null) gave 0. `real getOrderInfo maps a NULL allow_list to 0` (test/unit/activations/list/empty_allow_list_unlisted_order.test.js) therefore failed. Fixed by coalescing to 0.

Tests:
- order_u64_exact_read.test.js (row verify command): 3 pass, 0 fail
- empty_allow_list_unlisted_order.test.js: 3 pass, 0 fail
- No whole-suite run, as instructed.

Notes:
- The `sync trunk` merge of origin/develop (develop is only on origin here) brings develop's own changes to paths outside Surfaces (ci.yml, src/actions, etc.); those come from the required merge, not from edits in this lane.
- The suite-title pin was merged by hand (no docs snapshot to regenerate); the test file is unchanged so its hash a0d748730ca77c3b still holds. The push gate should confirm.

RUN-COMPLETE 82a7c5d88b0fe5043baf1d57c5dcb564
