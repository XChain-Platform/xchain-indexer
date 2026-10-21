# Lane report: cx-xc-5961

## Files touched
- src/consensus/bridge_proof_client/checkpoint_source.js: selectCheckpoint now binds section versions [0, 3] on both anchor reads (block_index and anchor axis) when bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION is active at the settling block (gate_registry activeAt); below it the single version 0 is bound as before. Exports sectionVersions and V3_SECTION_KEY.
- test/unit/consensus/bridge_proof_client/checkpoint_v3_section_pick.test.js: new, 5 tests.

## Tests
Verify command's mocha set (T1, T2, escrow_anchor_match, due_set_and_checkpoints): 41 passing, 0 failing. The grep checks on the gate read and the T2 words hold.

## Notes for the orchestrator
- src/db/anchor_sql.js left unchanged on purpose (CHECKPOINT_SECTION_VERSIONS also feeds getanchoraction). The DB reads in db/anchors and checkpoint_anchor_axis.js already accept a version list, so they needed no change.
- bin/pins/at1-suite-titles.json NOT updated: the new test titles (and a content hash for the new test file) belong in the generated pins; regenerate with bin/regenerate-pins.sh, which may touch pin files outside Surfaces. Parked here.
- The verify command diffs against origin/develop; that ref was not checked out locally, the anchor_sql.js condition holds trivially since the file is unchanged.
- npm ci was run to run the tests (node_modules not committed).

RUN-COMPLETE 79efa20106fde06729bdbeeee5db9d92
