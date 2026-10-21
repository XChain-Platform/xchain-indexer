# Lane report: cx-xc-5961-p2

Branch cloud/run-948722db0390, built on base 3bbcabc11e99ce5137e6463348905e5f2c02624b.

## Files touched
- test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js (new, 8 tests)
- bin/pins/at1-suite-titles.json (new file entry and its 8 titles under test, test:regression, test:regression:fast, test:regression:full)

No source file changed. The test names no section gate key and stubs no gate.

## Tests
- mocha on the new file plus escrow_anchor_match.test.js and checkpoint_v3_section_reads.test.js: 30 passing, 0 failing.
- The new tests cover: ANCHOR_SECTION_VERSION is 0; BTC origin at 157500 and DOGE origin at 157000 read getEarliestValidAnchorCheckpoint (chain, testnet, snapshot_block, version [].concat == [0]); DOGE origin at 157500 reads getEarliestValidAnchorCheckpointAfterAnchor and never the block_index read; empty reads return null; a version 0 anchor row is picked with source anchor_actions.

## For the orchestrator
- Not done: the "merge develop" step. The run contract says to build only on the base commit, and this checkout has no develop ref, so no merge was made and there were no conflicts to resolve.
- `node bin/suite-title-map.js --compare` could not run to completion here: the vendored xchain-vm directory is absent from this checkout (npm ci installed everything else), so mocha dry-run fails to load some suites and the tool cannot regenerate the pin. I edited the pin by hand in the tool's exact format (the existing file round-trips byte for byte through the tool's serializer): titles taken from mocha --dry-run of the new file, set key by the tool's own sha256 rule, file entries sorted, fileCount +1 and titleCount +8 on the four scripts whose globs include the sibling checkpoint_v3_section_reads test. Please re-run the compare where xchain-vm is present.
- The merge-base surface check in the verify command needs origin/develop, which is not present here; the only paths in my diff from the base are the two surfaces.
RUN-COMPLETE c3571dd0190ed78e902c6e5744112141
