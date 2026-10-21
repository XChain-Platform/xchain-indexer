# Lane report: cx-xc-6085

## Files touched
- src/actions/coinpay/payment_pool.js: resolvePayeeOutput, measurePool made module-local (called with .call(this, ...))
- src/actions/order_match/match.js: isNativeReciprocal, hasFillRoom, isListAllowed made module-local

## Tests
- `npm test` (mocha unit suite): could not run. Every test file fails to load in this session with
  "xchain-vm readonly accessors resolve at neither src/readonly-accessors.js nor src/readonly_accessors.js"
  (test/helpers/setup.js dependency missing in the hosted env). Same failure on the base commit, so 0 pass / 0 fail, unverified.
- Smoke check: `node -e require(...)` on both edited modules loads; exports are now
  match.js: loadOrderLists, fillMatch; payment_pool.js: resolvePaymentPool, openBatchLedger, drawFromPool. `node --check` passes.

## For the orchestrator
- tmp/line-scope-2026-10-19/dead-exports-indexer-1021.txt does not exist in the repo, so the list of 10 names could not be read.
  I rebuilt it: exported names in the seven surfaces with no mention in any other tracked file (git grep -w).
  Only these 5 qualify, and all are handled above. Earlier commit 46bc622 already unexported 5 more (isTokenReciprocal etc.) in match.js and sweep modules, which is likely the rest of the 10.
- Remaining exports in the surfaces are each mentioned by another tracked file, so they are kept:
  fee_pricing.js (priceFeeQuote, nativeFeeMandatory, decodeDeployCodeBytes, staticProtocolFee), cross_chain_remote_token.js (all six names),
  tick_rules.js (used by issue/index.js), settle.js (settleFill used by match.js; recordFill, settleOrderGiveSide, settleMatchGiveSide only mentioned in tests/other mixins),
  price/v0.js (used by price/index.js; parseRoundList only in a test harness).
  Names mentioned only by tests (decodeDeployCodeBytes, remoteTokenCanonical, REMOTE_TOKEN_ADMISSION_KEY, parseRoundList, recordFill, settleOrderGiveSide) would need the tests edited to unexport; tests are outside Surfaces.
- The review claim "only four removed, six unaccounted" is not reproducible without the list file; the above is the evidence for the rest.

RUN-COMPLETE db6f042846bf5ac9ab842bdd99daaa3c
