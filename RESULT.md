# Lane report: cx-xc-5961

## Files touched
- src/consensus/bridge_proof_client/checkpoint_source.js: selectCheckpoint reads section versions [0, 3] when bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION is active (gateRegistry.activeAt at the settling chain's ctx.network, ctx.coin, ctx.blockIndex), and version 0 alone below it, on both the block_index and anchor axes. Exports ANCHOR_V3_SECTION_VERSION, V3_SECTION_KEY, sectionVersions.
- test/unit/consensus/bridge_proof_client/checkpoint_v3_section_pick.test.js (new): 4 tests covering both axes, gate on and off, and the anchor_actions source tag.

## Tests
- Verify command from the brief: 40 passing, 0 failing.

## Notes for the orchestrator
- The DB reads (anchors/index.js, checkpoint_anchor_axis.js) already accepted a version list, so they needed no change.
- src/db/anchor_sql.js is unchanged, as the verify command requires.
- NOT DONE: bin/pins/at1-suite-titles.json. The new test file's titles and file hash need the pin regenerated with bin/regenerate-pins.sh suite-titles, which needs XCHAIN_DOCS_DIR (a documentation snapshot) that this lane does not have. Hand-editing would guess the hashes. Regenerate it where the docs snapshot exists.
- npm ci was run to run the tests; node_modules is untracked and not committed.

RUN-COMPLETE a5c0ed82159c2c2d5ef2d715f9062f96
