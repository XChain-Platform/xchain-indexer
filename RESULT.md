# Lane report: cx-red-1021813d

## Cause of the red
Run 39569482535, job `integration`: 439 passing, 2 failing, both from
`test/integration/migration_live_schema_guard.test/mirror_id_unsigned_replay.test.js`
("refuses the alignment before any DDL when a stored id is negative").
`exactU64TypeCast` (src/db/database/exact_u64.js, installed pool-wide in
src/db/database/instance_state.js) routed EVERY BIGINT through `exactU64`.
A signed BIGINT holding -5 reached `exactU64('-5')`, which threw
`TypeError: u64 value is not an integer` inside the mariadb row parser. That
destroyed the connection ("Connection destroyed, command was killed") so the
migration guard never produced its expected "live MIN(id) is -5" message, and
mocha also reported "done() called multiple times".

## Fix
The type cast now delegates to `next()` for signed BIGINT columns
(`field.signed()` from the mariadb connector's column object); only unsigned
BIGINT columns go through the exact u64 boundary.

## Files touched
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js (two cases added)
- RESULT.md

## Tests
- `npx mocha --no-config --no-package test/unit/db/database/exact_u64.test.js`: 9 passing, 0 failing.
- NOT run: `CI_TIER=fast npm run ci:full` and the integration tier. This
  container has no sibling repos (../xchain-vm etc.) and no MariaDB, so the
  full gate cannot run here (the prior review's complaint about that is
  accurate; it is an environment limit, not something fixable inside the
  writable surface). The integration test needs a MariaDB; the fix is
  verified only by reading the failure trace against the code and the unit tests.

## Notes for the orchestrator
- Please re-run `CI_TIER=fast npm run ci:full` in a checkout with siblings and
  MariaDB to confirm the acceptance.
- Base commit 73511cfb is "Refresh the generated pins"; the red run's head was 1021813d (same subject), so the code under test should match.

RUN-COMPLETE 4af13dfda17694b8fa99721ae43a6e15
