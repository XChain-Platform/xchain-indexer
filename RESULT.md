# Lane report: cx-xc-5885

## Files touched
- src/protocol_changes/changes_5.js (conflict resolved in the merge commit "sync trunk")

## What happened
The push gate's rebase onto develop failed on src/protocol_changes/changes_5.js only. Merging origin/develop reproduced a single conflict in that file. Develop meanwhile landed its own fix for the same row: a local `exactIntegerWireRegtestTime` resolver (unset or empty arms from genesis at 0, a non-negative integer arms at that height, any other value such as `off` stays UNARMED), plus tests that pin that behaviour, including `off` staying inert. The earlier shared-override change (`regtestTimeOverride`) does not give `off` the inert result, so it would have broken develop's tests.

Resolution: kept develop's resolver for EXACT_INTEGER_WIRE_FIELDS. The merged tree is identical to origin/develop, so this lane adds no content beyond the merge itself. The row's acceptance holds with develop's resolver: with EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME set to a positive height the registry row opens at that height, and unset it is armed from genesis (0).

## Tests
No test suite was run, per the lane rule (no whole-repo runs). Only `node --check` on changes_5.js: passed.

## Notes for the orchestrator
- The gate's reason named no test file or test name; it was a pure content conflict, not a test failure.
- I did not verify the decoder or e2e side, which are outside this repository and outside Surfaces.
- Base commit cfb9a8ed was confirmed on origin/cloud/base-bd8b506ef09a before branching.

RUN-COMPLETE 7e36bfefac31c4e90c188e4dfa19a8ce
