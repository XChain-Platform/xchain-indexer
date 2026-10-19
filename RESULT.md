# Lane report: cx-xc-5712

## Files touched
- test/unit/api/rpc/attest_batches.test.js (schema from src/sql via makeMigrationDb; named-column inserts)
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js (same)
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js (index_addresses stand-in replaced by src/sql/index_addresses.sql)
- db_xbridge_writers.test.js and list_share_tables.test.js: unchanged. They only parse DDL files and have no hand-written seed tables.

## Tests
- Verify grep (no CREATE TABLE in the three files): pass.
- `npm test` could not run to completion here: the run aborts at load because sibling checkouts are absent (xchain-vm, and xchain-documentation test vectors). This is an environment limit unrelated to the change.
- Touched and neighbouring suites (test/unit/api/rpc, test/unit/rollback/rollback.test, db_xbridge_writers, list_share_tables): 250 passing, 0 failing, identical before and after the change.
- relay_identity_db.js is a real-MariaDB fixture; it was syntax-checked only (no database available). It reuses the same comment stripper already applied to attests.sql.

## Notes
- Tests use the existing helper test/helpers/sqlMigrationDb.js (MySQL to sqlite translation); no helper changes were needed.

RUN-COMPLETE ae4d621244ed126dab9a1c30415bb14f
