# Lane report: cx-red-1021813d

## Files touched
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js

## Cause
The red run (39569482535) failed in the `integration` job: mirror_id_unsigned_replay
"refuses the alignment before any DDL when a stored id is negative" threw
`u64 value is not an integer` from exactU64TypeCast. The pool-wide typeCast (added in
8f76295) ran on every BIGINT, including signed columns, so reading a negative id
(MIN(id) = -5) threw before the guard could produce its message. The second failure
(done() called multiple times) was a knock-on of the first.

## Fix
exactU64TypeCast now delegates signed BIGINT fields (UNSIGNED flag 32 unset) to the
connector. Fields with no flags are still treated as unsigned, keeping existing behavior.

## Verification
- `node -e` spot check of the three cases (signed, unsigned, no flags): pass.
- `CI_TIER=fast npm run ci:full`: NOT RUN to completion. This hosted checkout has no
  node_modules and none of the sibling repos (xchain-vm, xchain-decoder, xchain-sdk,
  xchain-hub, xchain-documentation) beside it, so the script exits 1 at its sibling check
  ("MISSING SIBLING") before any test. The unit and integration suites were not run here
  (0 pass / 0 fail counted). The orchestrator should run the command in a full lane checkout.
- Note: the failing job is the integration tier, which CI_TIER=fast defers.
