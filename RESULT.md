# Lane report: cx-xc-5989-p1

## Files touched
- bin/pins/at1-suite-titles.json (conflict resolved in the develop merge, commit "sync trunk")
- test/unit/actions/execute.test/guard_emitted_host_request_id_below_gate.test.js (unchanged this round)

## What happened
- The base ref fetched equals 9c7741c4; the result branch was created from it.
- Merged origin/develop (cc983572). The only conflict was bin/pins/at1-suite-titles.json. I resolved it as a three-way JSON merge (merge base 89dc1981, ours, develop) so that develop's pin changes (balance_delta_mode hash, terminal_flip_resolved_block entry, counts) and this row's pin changes (the new test file plus the integration entries) both stand. File and title counts were recomputed from the merged title sets. Output keeps the tool's formatting (escaped non-ASCII, sorted keys).
- The merge brings develop's files (src/config.js and two tests) into this branch's diff against the base commit. That is the merge the brief asked for; the diff against merge-base with origin/develop touches only the two surfaces.

## Why the last attempt failed
The title_dropped lines (attest_responsible_set_vectors and others) come from the hosted sandbox, not the pin. That suite builds its cases from a sibling checkout that is absent here, so it collects one title instead of about 117. The vendored xchain-vm directory is also empty, so `bin/suite-title-map.js --compare` cannot collect test, test:integration or test:regression in this sandbox (collection_error). The pin cannot be regenerated or fully compared here. Please run the compare in an environment with the sibling checkout and xchain-vm.

## Checks run
- mocha on guard_emitted_host_request_id_below_gate, guard_async_emission_deny, emission_routing: 32 passing, 0 failing.
- Dry-run title hash of the new test file is 494348d00a38395f, equal to the pinned value.
- `node bin/suite-title-map.js --compare`: not passable here (collection_error for the scripts above, environment only). Not verified end to end.

RUN-COMPLETE 9c33334f15d5134eb2aa03d29916d14f
