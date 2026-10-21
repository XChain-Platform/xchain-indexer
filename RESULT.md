# Lane report: cx-xc-6058

## Files touched
- bin/pins/at1-consensus-identity.json (new commit this round)
- src/protocol_changes/gates_6.js, test/helpers/gate_modules.js, test/unit/protocol_changes/predicate_parity.test.js, test/unit/consensus/armed_map/manifest.test.js, test/unit/repo_guards/consensus_identity_gates_field.test.js: carried from the previous rounds (the gate row and its census tests)
- predicate_parity.test.js merge conflict with develop resolved: registry-only census is 86 + 1 + 1 (develop's batch-airdrop row plus this row), keeping develop's batch-airdrop assertion.

## Cause of the last failure
The committed pin had no entry for bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION, so `consensus-identity --compare` exited 1 (mismatch on armed_map_fingerprint, the new armed_map_rows entry and armed_map_row_count) and the test expecting 0 failed. Fixed by re-pinning both readings: row entry added (hash ef92238c, the shared unarmed value), row count 467 to 468, fingerprint bare ee70bbee to 83adfeb8, armed e3f7ac28 to dfcd12ce. The rules digest, GATES field hash, coin registry and carrier logic digest are unchanged.

## How the pin was computed (please re-read in a full checkout)
This container has no sibling xchain-vm or xchain-hub checkout. I recovered the 22 xchain-vm mirror row values by matching them against the pinned row hashes, built a stub xchain-vm outside the repo (tmp/stub, via NODE_PATH), and checked the method first: with the new row removed it reproduced the pinned fingerprints exactly (bare ee70bbee, armed e3f7ac28, 467 rows). With the stub, `node bin/consensus-identity.js --compare bin/pins/at1-consensus-identity.json` exits 0. Please confirm with a real vendored xchain-vm before relying on it.

## Tests
`npx mocha ... predicate_parity, manifest, fingerprint, consensus_identity_gates_field` after `npm ci --ignore-scripts` and NODE_PATH stub: 39 passing, 12 failing. All 12 failures come from the missing environment, not the change: real XChainVM constructor absent from the stub, temp-tree copies that cannot see the stub, and /home/user/xchain-hub absent for the hub shared-row check. Without the stub: 26 passing, 19 failing for the same missing-vm reason. predicate_parity passes in full. The verify command's grep and registry-row checks were not run separately; the mocha part cannot pass here for the reasons above.

RUN-COMPLETE 119e65015127ded7bf63f45d6c5dd981
