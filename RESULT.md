# Lane report: cx-red-1021813d

## Files touched
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js

## Cause
The red job was `integration`. test/integration/migration_live_schema_guard.test/mirror_id_unsigned_replay.test.js
("refuses the alignment ... when a stored id is negative") failed with
`TypeError: u64 value is not an integer` from `exactU64TypeCast`: the pool-wide BIGINT type cast
rejected the signed `MIN(id)` value `-5` the guard reads, so the guard never produced its message.

## Fix
`exactU64TypeCast` now returns a negative signed BIGINT exact (Number when safe, decimal string
otherwise). Unsigned handling and range checks in `exactU64` are unchanged.

## Tests
- `npx mocha --no-config --no-package --spec test/unit/db/database/exact_u64.test.js`: 8 passing, 0 failing
  (includes a new case for negative values).
- `CI_TIER=fast npm run ci:full`: NOT verified here. The hosted checkout has no sibling repos
  (`../xchain-vm` etc.), so the script exits at its sibling check before running any tier. The
  failing integration test also needs a MariaDB endpoint, which is absent here. The orchestrator
  should re-run the command in the lane checkout with siblings present.
RUN-COMPLETE 53680a4d5f3e916ab12947ee02849c4b
