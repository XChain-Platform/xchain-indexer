# Lane report: cx-xc-5961-p2

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 8 tests)
- bin/pins/at1-suite-titles.json (new titles added for scripts test, test:regression, test:regression:fast, test:regression:full)

No source file changed. The test names no gate key for the v3 section flag.

## Test commands
- `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js --exit <baseline test> test/unit/bridge/escrow/escrow_anchor_match.test.js test/unit/consensus/bridge_proof_client/checkpoint_v3_section_reads.test.js`: 30 passing, 0 failing.
- `node bin/suite-title-map.js --compare bin/pins/at1-suite-titles.json`: could NOT pass in this session. The vendored xchain-vm package is absent from the checkout (node_modules/xchain-vm is a dangling link), so mocha collection errors for unrelated spec files, 6 collection_error differences, none about the new file.

## Notes for the orchestrator
- Pin was updated by hand with the tool's own set-key hash (sha256 of titles, 16 hex), sorted titles, file/title counts, and ASCII escaping. The title list was checked equal to a mocha dry-run of the new file under the regression grep. Re-run the compare where xchain-vm exists to confirm.
- Merge of develop was NOT done: no develop or origin/develop ref exists in this clone, and the run contract requires building on the base commit only. If develop changed bin/pins/at1-suite-titles.json, the pin will need a re-take after the merge.
- The verify script's `git merge-base HEAD origin/develop` cannot run here for the same reason.
- npm ci was run with --ignore-scripts to run tests; node_modules is untracked and not committed.

RUN-COMPLETE acd4e3d020a92be726ecc25e037bad52
