# Lane report: cx-xc-5712

## Files touched
- test/unit/api/rpc/attest_batches.test.js: tables now come from src/sql via test/helpers/sqlMigrationDb.js (makeMigrationDb); rows inserted with named columns.
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js: same loader; inserts use explicit column lists (real DDL has extra columns such as signing_pubkey_id).
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js: the hand-written index_addresses stand-in is replaced by src/sql/index_addresses.sql (comments stripped with the product stripper, like attests.sql).

Untouched on purpose: test/unit/bridge/db_xbridge_writers.test.js and test/unit/list_share/list_share_tables.test.js. They are DDL parsers and migration comparisons that already read src/sql and only mention CREATE TABLE as text they search for; they seed no table.

## Verification
- Grep half of the verify command: passes (no CREATE TABLE in the three files).
- mocha --no-config on attest_batches.test.js and maturity_escrow_release_reversal.test.js: 18 passing, 0 failing.
- relay_identity_db.js loads cleanly (node require with INDEXER_COIN/INDEXER_NETWORK set). Its integration suites need a real MariaDB (TEST_DB_PASS), which this host lacks, so the changed buildSchema path was not executed.
- `npm test` could not complete here: mocha aborts at load with "xchain-vm readonly accessors resolve at neither src/readonly-accessors.js nor src/readonly_accessors.js" (test/unit/attestation/db_get_attestation_data_for_vm.test.js; also vm_gate_coverage.test.js, missing sibling xchain-vm checkout). This is environmental and independent of this change. 0 pass / 0 fail counts for the full run.

## Notes
- index_addresses.sql begins with DROP TABLE IF EXISTS, harmless on the freshly created schema.

RUN-COMPLETE 9856a51829a3dc06b96320a488da4194
