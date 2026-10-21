# Lane report: cx-xc-5961

Files touched:
- src/consensus/bridge_proof_client/checkpoint_source.js: selectCheckpoint reads anchor_actions section versions [0, 3] when bridge_checkpoint_v3_section_activation is active at the settling block (gate_registry activeAt), version 0 alone below it; both the block_index and anchor axes.
- test/unit/consensus/bridge_proof_client/checkpoint_v3_section_pick.test.js (new): at and above the flag day, below it as the negative control, and the anchor axis for a DOGE origin.
- bin/pins/at1-suite-titles.json: pinned the new test's titles by hand (4 scripts, fileCount and titleCount bumped).

Not touched: src/db/anchor_sql.js (CHECKPOINT_SECTION_VERSIONS also feeds getanchoraction). The db reads already accepted a version list, so anchors/index.js and checkpoint_anchor_axis.js needed no change.

Tests: the Verify command's mocha run, 4 files, 39 passing, 0 failing. The gate and anchor_sql guards also pass.

Notes:
- The branch lane/XC-5961 did not exist in this checkout; work started from the base commit as instructed.
- bin/regenerate-pins.sh suite-titles needs a documentation snapshot (XCHAIN_DOCS_DIR) not available here, so the pin was edited by hand using the file's own set-key hash. Regenerate it when a snapshot is at hand to confirm.
- The previous review said no tests existed; the pick test and the negative control are now present. Existing escrow_anchor_match and due_set tests were left as is.

RUN-COMPLETE 0f4f24c40c4defa4c01e440c1e8d1773
