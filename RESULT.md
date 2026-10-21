# Lane report: cx-xc-5961-p2

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 6 tests)
- bin/pins/at1-suite-titles.json (new title set e52c48c518961262 and the new file added to the test, test:regression, test:regression:fast and test:regression:full entries; counts +1 file, +6 titles each)

No source file changed. The test stubs no gate and does not name the v3 section key.

## Test commands
- `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js --exit <new test> test/unit/bridge/escrow/escrow_anchor_match.test.js test/unit/consensus/bridge_proof_client/checkpoint_v3_section_reads.test.js`: 28 passing, 0 failing (6 new).
- `node bin/suite-title-map.js --compare bin/pins/at1-suite-titles.json`: NOT a pass in this session. It reports collection errors for the test, test:integration and test:regression* scripts because the sibling package `xchain-vm` is not installed in the hosted checkout (Cannot find module 'xchain-vm'). The failure is environmental and unrelated to this change. The pin was instead edited by hand with the tool's own algorithm (titles from `mocha --dry-run --reporter json`, sorted; set key is the first 16 hex of sha256 of the titles joined by newline; the file was inserted in sorted order into every script that collects the sibling checkpoint_v3_section_reads test). A round trip of the unedited pin through the tool's serializer was byte identical before the edit. Please re-run the compare where xchain-vm resolves.

## Notes for the orchestrator
- Develop merge NOT done: the checkout has no develop or origin/develop ref (only the lane's own branch), and the run contract requires building directly on base commit 3bbcabc1. So no conflict in the pin was resolved. If develop moved the pin, a later sync will need a pin re-take.
- The verify command's `git merge-base HEAD origin/develop` cannot run here for the same reason.
- npm ci was run to run the tests; node_modules and tmp/ are untracked and not committed.
RUN-COMPLETE e024e6c9d7c739ba80af02812bebb035
