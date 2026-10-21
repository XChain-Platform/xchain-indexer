# Lane report: cx-xc-6086

## Files touched
- src/consensus/anchor_reward_derive/legacy_reward_pins.js (DEFAULT_PINS_PATH)
- src/consensus/contract_state_subtree.js (touchedContractStateKeys)
- src/consensus/doge_peer_clients/anchor_proof_client/binding.js (bundleHeaderBlocks, bindsToTuple)
- src/consensus/doge_peer_clients/anchor_proof_client/page_walk.js (MAX_ANCHOR_PAGES)
- src/consensus/merkle.js (decompressSmtProof)
- src/consensus/xchain_price.js (WINSOR_BAND_FACTOR, RATE_PRECISION, PRICE_PRECISION)

9 of the 13 names are unexported. All stay defined, as each is used inside its own module.

## Not done (needs a file outside Surfaces)
Four names in gates/ were left exported: chainMarginBlocks (mirror_admission_margin_gate.js), isValidPriceValue (price_scale_gate.js), normalizeCollationName (stake_weight_collation_gate.js), parseRuleSetVersion (train_gate.js). Those four files are token-hash pinned in bin/pins/carrier-logic.json (with twins in other repos). Removing an export moves the hash and fails test/unit/repo_guards/carrier_logic_pin.test.js. A re-pin of bin/pins/carrier-logic.json via bin/lib/carrier_logic_pin.js --write is outside Surfaces. Follow-up: widen the row to include that pin file and re-pin, or accept keeping these four exported.

## Notes
- tmp/line-scope-2026-10-19/dead-exports-indexer-1021.txt is not in the repo at the base commit. I recomputed the list by scanning every tracked file for each export name of the 10 surfaces. It found exactly 13 names, matching the row.
- The sandbox has no sibling xchain-vm or xchain-documentation checkout, so some tests cannot load.

## Tests
Ran each file under test/unit, test/regression and test/security separately (1510 files) with `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js <file>`.
- Files passing: 1462. Files failing: 48.
- The same 48 files fail on the base commit, with identical exit codes. Causes are missing xchain-vm / xchain-documentation checkouts and a missing COIN config. None involves the changed code.
- After reverting the four gate files, carrier_logic_pin.test.js passes (15 passing).
- Whole-suite `npm test` aborts at load on the missing xchain-vm, on base as well.

RUN-COMPLETE 6e17b63b4c2fc067fc2020daf5aa0cb3
