# Lane report: cx-red-1021813d

Files touched:
- src/db/database/exact_u64.js
- test/unit/db/database/exact_u64.test.js

Cause (from GitHub run 39569482535, job integration): test mirror_id_unsigned_replay "refuses the alignment before any DDL when a stored id is negative" failed with `TypeError: u64 value is not an integer`. The pool-wide exactU64TypeCast ran on a signed BIGINT read ("-5" from the live MIN(id) guard probe) and threw, so the guard's own refusal message was never produced. Fix: the type cast now returns negative integer strings exactly (Number when safe, else decimal string) instead of applying the unsigned check; u64 columns keep all existing checks.

Tests:
- `npx mocha --no-config test/unit/db/database/exact_u64.test.js`: 8 passing, 0 failing (one new case).
- `CI_TIER=fast npm run ci:full`: NOT verified here. It exits 1 immediately in this hosted session with "MISSING SIBLING /home/user/xchain-vm" (sibling repos are not checked out beside the repo, and no MariaDB is available). The failing test is a DB integration test (needs TEST_DB_*), also not run here. Orchestrator should rerun ci:full in the lane checkout with siblings and DB.

Notes: npm ci was run for local tests; node_modules and tmp/ are not committed.

RUN-COMPLETE b426c1e84bd0ef55d796de1ec1740c14
