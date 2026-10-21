# Lane report: cx-xc-5961-p2

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 5 tests)
- bin/pins/at1-suite-titles.json (new title set plus the new file added to the test, test:regression, test:regression:fast and test:regression:full scripts, the same scripts that collect the sibling checkpoint_v3_section_reads test)
- RESULT.md

## Tests
- mocha on the new test, escrow_anchor_match.test.js and checkpoint_v3_section_reads.test.js: 28 passing, 0 failing.
- `node bin/suite-title-map.js --compare bin/pins/at1-suite-titles.json`: NOT RUN to a verdict. It fails with "Cannot find module 'xchain-vm'": the vendored ./xchain-vm directory is absent from this checkout, so the full dry-run collection cannot load. The pin was instead edited by a script from a mocha dry run of the new file alone (hash and sort rules copied from bin/suite-title-map.js). Please re-run the compare where xchain-vm exists.

## Notes
- The "merge develop" step was NOT done. origin/develop has 7 changed files outside the surfaces (incl. a separate edit to the pin), so merging would put non-surface paths on the result branch, which the contract refuses. The merge-base of HEAD and origin/develop is the base commit, so the verify's surface check is unaffected. The pin will likely conflict on the develop side and needs a re-take after develop merges.
- No source file changed; no gate stubbed; the new test names no ledger id and not the v3 section key.
- node_modules installed with npm ci (ignored by git); tmp/ is git-ignored.

RUN-COMPLETE 0816ad02f748645681dbc7dc010e2bdd
