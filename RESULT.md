# Lane report: cx-xc-5961-p2

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 9 tests)
- bin/pins/at1-suite-titles.json (new titles and counts added for the new file)

No source file changed. The test names no v3 section gate and stubs no gate.

## Tests
- `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js --exit` on the new file, escrow_anchor_match.test.js and checkpoint_v3_section_reads.test.js: 31 passing, 0 failing.

## For the orchestrator
- The brief's "merge develop" step was NOT done. The run contract requires the branch to be built exactly on base commit 3bbcabc1 and on no other commit, and the two conflict. The pin was therefore taken against 3bbcabc1 and may conflict with develop (ca114f58) in bin/pins/at1-suite-titles.json. The change is additive: one new titleSets entry (fc4ae6bbb743553b) plus one file entry and count bump (+1 file, +9 titles) in the scripts test, test:regression, test:regression:fast and test:regression:full.
- `node bin/suite-title-map.js --compare` could not run to completion here: the vendored ./xchain-vm dependency is absent in this container, so many unrelated suites fail to load. The pin was edited by hand, mirroring the sibling checkpoint_v3_section_reads.test.js entries, with the same hash (sha256 of the sorted titles, 16 hex) and the same \u escaping the tool writes. The title list came from mocha --dry-run on the new file. Re-run the compare where xchain-vm exists.
- The verify script's merge-base check against origin/develop was not run for the same reason (the diff touches only the two surfaces).

RUN-COMPLETE 8f88d0d6ddcefba62cc13dd469d09c62
