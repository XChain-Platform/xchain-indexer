# Lane report: cx-red-1021813d

Files touched:
- src/db/database/migration_live_schema_guard.js
- test/unit/migration/migration_runner.test/live_schema_guard.test.js

Cause: the integration job failed in mirror_id_unsigned_replay.test.js. The unsigned retype probe ran
`SELECT MIN(id)` through the pool's u64 BIGINT typeCast (exactU64), which throws TypeError on a
negative value, so the guard never produced its "live MIN(id) is -5" refusal. Fix: the probe now
reads `CAST(MIN(id) AS CHAR)`, which bypasses the BIGINT cast. The unit test's expected SQL was updated.

Tests: NOT RUN. This sandbox has no node_modules, no MariaDB, and the sibling repos (../xchain-vm etc.)
that `CI_TIER=fast npm run ci:full` requires are absent, so ci:full exits 1 at "MISSING SIBLING"
before running anything. Pass/fail counts: none. The fix is verified by reading the failing CI log only.
The orchestrator must run ci:full in a full lane checkout to confirm exit 0.
RUN-COMPLETE 20b5aae2c09c4dc71054b9862cd79afa
