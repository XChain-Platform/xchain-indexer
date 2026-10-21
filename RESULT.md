# Lane report: cx-xc-5979

Branch cloud/run-c87b06b42a12, started from base commit bf7fa0da.

## Files touched
- src/protocol_changes/gates_6.js: merged origin/develop (it has no local develop branch), keeping develop's archive_orphan_geometry gate and this row's batch_airdrop_leg_weight gate.
- bin/pins/at1-consensus-identity.json: conflict resolved by taking develop's file whole, so hub_shared_rows_commit is develop's value (c37f9b69...). That fixes the attempt-2 finding. The gate-derived fields were NOT refreshed (see below).
- test/unit/protocol_changes/predicate_parity.test.js: REGISTRY_ONLY.size 86 -> 87.

## Tests
- predicate_parity.test.js: 5 passing, 0 failing.
- manifest, fingerprint and consensus_identity_gates_field tests: 24 passing, 19 failing in the full run before the census edit. The failures need the vendored xchain-vm package (file:./xchain-vm), which is an empty directory in this checkout. Armed-map fingerprint reads UNREADABLE, so those tests cannot pass here, and neither can bin/regenerate-identity-pin.js.

## For the orchestrator
1. The pin still needs a regeneration run by a lane that has xchain-vm: `node bin/regenerate-identity-pin.js`. It rewrites only the two code blocks and leaves hub_shared_rows_commit alone. Expect armed_map_fingerprint, the new armed_map_rows entry for batch_airdrop_leg_weight_activation.BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION, armed_map_row_count, and the rules digest to move.
2. The Verify command greps for "REGISTRY_ONLY.size, 86". Develop already counts 86 with the archive orphan gate, so this row makes 87, and that grep will fail on the correct value. The brief's number is stale; I kept the true count.
3. bin/pins/at1-consensus-identity.json was the previous round's refusal reason; it is now unchanged from develop, so that finding no longer applies.

RUN-COMPLETE 885cbf698a2eba46c664ffe3e63e6b42
