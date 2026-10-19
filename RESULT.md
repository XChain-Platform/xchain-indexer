# Lane report: cx-xc-5712

## Files touched
- test/unit/api/rpc/attest_batches.test.js (tables now loaded via makeMigrationDb from src/sql)
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js (same)
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js (index_addresses stand-in replaced by src/sql/index_addresses.sql)

Not changed: test/unit/bridge/db_xbridge_writers.test.js and test/unit/list_share/list_share_tables.test.js. Their CREATE TABLE text is a parser/slicer over the real migration or src/sql files (inline DDL kept per the row), no hand-written seed table.

## Tests
- Grep gate (no "CREATE TABLE" in the three files): pass.
- mocha on attest_batches + maturity_escrow_release_reversal (--no-config): 18 passing, 0 failing.
- relay_identity_db.js loads cleanly; the integration suite needs a MariaDB (DB_PASS) and was not run here.
- Full `npm test`: aborts at load in this sandbox with "xchain-vm readonly accessors resolve at neither ..." (sibling xchain-vm checkout absent, module not installed). Identical failure on the untouched base commit, so it is environmental and not caused by this change. Orchestrator should rerun `npm test` where the sibling checkout exists.

## Notes
- Real DDL has extra NOT NULL columns (attests.provider_id, actions.block_index/action_id, transactions.block_index, unstakes.signing_pubkey_id), so seed inserts now name their columns.
- Unrelated: npm ci was run locally; node_modules and tmp/ are untracked/ignored.

RUN-COMPLETE 4419aa18b290dc05fd6c8c35703415e5
