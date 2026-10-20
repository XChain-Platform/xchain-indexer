# Lane report: cx-xc-5885

## Files touched
- src/protocol_changes/changes_5.js (conflict resolved in the merge commit "sync trunk")

## What happened
- Base ref fetched and verified as cfb9a8ed6df85d5edeb4757f26619d3871ceab5a; result branch created from it.
- Merging develop (origin/develop, 3bfbcb84) conflicted only in changes_5.js, as the push gate said.
- develop already implements this row: a local exactIntegerWireRegtestTime() returns 0 when
  EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME is unset or empty, the positive height when set, and
  UNARMED for any other value such as off. Its tests (already on develop) assert this.
- The previous round's change used the shared regtestTimeOverride, which maps "off" to 0 (armed),
  contradicting develop's tests. So I resolved by taking develop's version of the file entirely.
  The file now equals origin/develop exactly; this lane adds no net change to it.
- The merge commit also carries develop's changes to bin/pins/*.json and two unit tests. Those paths
  are outside Surfaces but come only from the develop merge, not from lane edits. If the gate refuses
  merge-brought paths, the orchestrator should treat the row as already satisfied on develop.

## Tests
No tests run: the lane does not start suites. Only a load of changes_5.js with the variable unset was
attempted; it printed no error. Pass 0, fail 0.

## Notes
The gate reason named no test file or test; per brief, no suite search was done. The decoder and e2e
sides live outside this repository and were not checked here.

RUN-COMPLETE bc86f4ac9916740554eb109490725d7d
