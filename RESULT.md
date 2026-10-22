# Lane report: cx-xc-5950-p9

## Files touched
- test/integration/archive_heads_by_author_db.test.js (new)
- bin/pins/at1-suite-titles.json (new test's 5 titles added to the test:integration and test:integration:ci file maps, one new title set; fileCount 72 to 73, titleCount 440 to 445; every other line untouched)

## Test commands and counts
- `TEST_DB_PASS=test npx mocha --no-config --timeout 120000 --exit test/integration/archive_heads_by_author_db.test.js`: 5 passing, 0 failing (against a local MariaDB 10.11 started in the session).
- `npx mocha --no-config --timeout 30000 --require ./test/helpers/setup.js --exit test/unit/bin/archive_heads_by_author.test.js`: 16 passing, 0 failing.
- Surface and keyword checks from the verify script (all named words present, no ledger id, no em-dash, only the two surfaces changed): pass.

## Notes for the orchestrator
- `bin/run-db-tiers.sh -- test/integration/archive_heads_by_author_db.test.js` was NOT run: this hosted session has no Docker daemon. The same file was run with mocha directly against a locally installed MariaDB 10.11 (the script uses 11.4), with the same TEST_DB_* variables the script exports.
- `node bin/suite-title-map.js --compare` could not complete here: the untracked `xchain-vm` dependency is absent, so the full dry-run collection errors for every script. The pin entry was therefore added by hand using the tool's own rules (full titles, sorted, sha256 of the newline-joined titles cut to 16 hex chars, mocha dry-run titles of this file). Re-run the compare in an environment with xchain-vm to confirm.
- The test seeds the two invalid reasons separately, keyed by full status text.

RUN-COMPLETE 3bd5110fb44c063d76cc6ae4e9f43660
