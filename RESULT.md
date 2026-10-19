# Lane report: cx-xc-5712

Files touched:
- test/unit/api/rpc/attest_batches.test.js (tables now from src/sql via test/helpers/sqlMigrationDb.js; inserts name their columns)
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js (same)
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js (index_addresses loaded from src/sql/index_addresses.sql)

Not changed: db_xbridge_writers.test.js and list_share_tables.test.js already read their DDL from src/sql and src/sql/migrations (parser-style tests), so no edit was needed.

Tests:
- grep check for CREATE TABLE in the three files: pass.
- Targeted mocha run (attest_batches, maturity_escrow_release_reversal, db_xbridge_writers, list_share_tables, attest_relay_identity): 34 passing, 0 failing, 11 pending (the MariaDB integration suite self-skips without TEST_DB_PASS, so the relay_identity_db.js change was not executed against a real engine).
- Full npm test: could not run to completion in this container. Mocha aborts while loading with "Cannot find module 'xchain-vm'" / missing sibling readonly accessors, which is an environment gap unrelated to these changes (a sibling checkout is absent). Pass/fail counts for the full suite are therefore unavailable.

Notes: the real DDL has NOT NULL columns the old stubs omitted (attests.provider_id, actions.action_id/block_index, transactions.block_index, unstakes.signing_pubkey_id), so fixtures now supply placeholder values for them.

RUN-COMPLETE 379a6fffcb3c3c453917fa95b8f9d56a
