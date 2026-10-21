# Lane report: cx-red-1021813d

## Files touched
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js

## Cause
GitHub run 39569482535, job `integration`: 2 failures, both in
`mirror id unsigned alignment replayed on signed ids @tier3` (refuses the
alignment when a stored id is negative). The migration guard reads
`MIN(id)` from a still-signed BIGINT column; the pool typeCast
(`exactU64TypeCast`) passed `-5` to `exactU64`, which threw
`TypeError: u64 value is not an integer` inside the mariadb row parser,
destroying the connection (second failure: done() called twice).

## Fix
`exactU64TypeCast` now defers negative integer strings to the connector
default (`next()`), so the guard sees -5 and raises its intended error.
Non-numeric and out-of-range values still throw. Added a unit test.

## Verification
- `CI_TIER=fast npm run ci:full` could NOT be run to green here: the cloud
  checkout has no sibling repos (xchain-vm, xchain-decoder, xchain-sdk,
  xchain-hub, xchain-documentation) and no node_modules or MariaDB, and
  bin/ci-full.sh exits at its need_sib check. Exit was 1 before the fix.
- Ran a direct node check of exactU64TypeCast: '-5' -> -5n, '2^53+1' stays
  exact string, 'abc' still throws. Mocha could not run (no node_modules).
- Needs a run of ci:full in the real lane checkout (siblings + DB present).

RUN-COMPLETE 61bf15c847036eff2e98c3afba67fea5
