# Lane report: cx-xc-5961-p2

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 6 tests)
- bin/pins/at1-suite-titles.json (new title set plus the file entry in test, test:regression, test:regression:fast, test:regression:full; counts +1 file, +6 titles)

## Tests
- `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js --exit` on the new test, escrow_anchor_match.test.js and checkpoint_v3_section_reads.test.js: 28 passing, 0 failing.

## Notes for the orchestrator
- Branch is cut from the base commit 3bbcabc1 as the contract requires. No `develop` ref exists in this checkout, so the "merge develop" step from the brief could not run; no conflict in the pin was seen. Re-run the sync if develop has moved.
- `node bin/suite-title-map.js --compare` reports 6 collection_error differences (test, test:integration, test:integration:ci, test:regression, test:regression:fast, test:regression:full) because the `xchain-vm` module is not installed in this sandbox. The same 6 appear on the untouched base, so they are environmental. For the same reason the pin could not be regenerated with `--out`; it was edited by script using the tool's own key hash and serialization, adding the file only to the scripts that already collect its sibling test (same tags). Please re-run the compare where xchain-vm resolves.
- DOGE-origin cases use ctx coin BTC on testnet: the registry threshold that matches 157000/157500 is the BTC:testnet entry (157235).
- No source file changed. The v3 section gate key is neither named nor read.

RUN-COMPLETE 0fb9126e0c87cd2a9a0ce9edd95820a2
