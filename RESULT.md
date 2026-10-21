# Lane report: cx-red-1021813d

## Cause
GitHub run 39569482535, job `integration`: `mirror_id_unsigned_replay.test.js`
("refuses the alignment before any DDL when a stored id is negative") failed with
`TypeError: u64 value is not an integer` from `exactU64TypeCast`, because the pool-wide
BIGINT type cast rejected the negative `MIN(id)` read from a still-signed mirror table.
The second failure (`done() called multiple times`) was a consequence of the first.

## Fix
`exactU64TypeCast` in `src/db/database/exact_u64.js` now returns a negative BIGINT text
exact (Number if safe, else decimal string) instead of throwing. `exactU64` stays strict.

## Files touched
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js (new case)

## Tests
- `npx mocha --no-config --spec test/unit/db/database/exact_u64.test.js`: 8 passing, 0 failing.
- `CI_TIER=fast npm run ci:full`: NOT PASSING HERE. It exits 1 immediately with
  "MISSING SIBLING /home/user/xchain-vm" (the seven siblings in .ci-siblings are not
  checked out beside this repo in this hosted session, and this session is scoped to this
  repo only). The integration test needs a MariaDB too. The acceptance command was therefore
  not run to completion; the orchestrator should run it in a lane checkout that has the siblings.

## Notes
The failure was diagnosed from the GitHub job log, not reproduced locally.

RUN-COMPLETE b801f42a8d920a14f23fb31c90ed0a91
