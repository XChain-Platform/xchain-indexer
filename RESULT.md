# Lane report: cx-xc-5950-p9

## Files touched
- test/integration/archive_heads_by_author_db.test.js (new, 7 cases, describe tagged @tier3)
- bin/pins/at1-suite-titles.json (new title set for that file added to test:integration and test:integration:ci; fileCount 72 to 73, titleCount 440 to 447; no other line changed)

## Tests
- `npx mocha --no-config --timeout 120000 --exit test/integration/archive_heads_by_author_db.test.js`: 0 passing, 7 pending (self-skip, TEST_DB_PASS unset). NOT RUN AGAINST A DATABASE.
- `bin/run-db-tiers.sh -- test/integration/archive_heads_by_author_db.test.js`: NOT RUN. This hosted session has no docker daemon and no MariaDB binary, so the pass count the row asks for is unreported and the SQL has not executed. The orchestrator must run it where a database exists.
- `test/unit/bin/archive_heads_by_author.test.js`: 16 passing, 0 failing.

## Notes
- The pin was updated by hand, not with `node bin/suite-title-map.js --out`: the untracked vendored xchain-vm is absent here, so the full collection errors. The new titles were taken from `mocha --dry-run` on the new file and keyed with the tool's own hash (sha256 of the sorted titles joined by newline, first 16 hex). The file round-trips byte for byte before the edit. `--compare` could not complete here for the same reason, so that check is unconfirmed.
- origin/develop is not a ref in this clone, so the surface-diff step of the verify command could not run; the branch touches only the two surfaces.
- Seed layout follows the row: status ids keyed by full status text; authors A and B; heads 40, 41, 42 (v2), 50 for A and 60 for B. Cases re-seed before each test.

RUN-COMPLETE f6cd34908470d6ad27f8351c6fd07c8b
