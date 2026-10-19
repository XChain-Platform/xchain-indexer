# Lane report: cx-xc-5712

## Files touched
- test/unit/api/rpc/attest_batches.test.js: index_statuses, attests, actions, transactions, index_transactions now load from src/sql via a local loadSrcSql (reuses test/helpers/sqlAnchorDb mysqlDdlToSqlite; skips indexes, strips charset and ENUM). Seeds use named columns.
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js: index_addresses, index_tickers, unstakes, contract_unstakes, credits, escrows load from src/sql the same way.
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js: the index_addresses stand-in now runs src/sql/index_addresses.sql (MariaDB, comments stripped like attests.sql).
- db_xbridge_writers.test.js and list_share_tables.test.js: no change. They contain no hand-written table DDL; they already read src/sql and migration files (parser style tests keep their inline patterns).

## Tests
- Verify grep (no CREATE TABLE in the three files): pass.
- mocha on attest_batches + maturity_escrow_release_reversal: 17 + 7 passing, 0 failing.
- test/unit/api + test/unit/rollback recursive: 719 passing, 0 failing, 9 pending.
- Full `npm test`: could not complete here. It aborts at load with "xchain-vm readonly accessors resolve at neither src/readonly-accessors.js nor ..." (test/unit/attestation/db_get_attestation_data_for_vm.test.js) and a missing ../xchain-documentation/protocol/test-vectors/list_share.json. Both are sibling checkouts absent from this sandbox, unrelated to this change.
- relay_identity_db.js (needs MariaDB and TEST creds) was not executed; it only loads as a module. The SQL it sends is the unmodified index_addresses.sql with comments stripped, run with multipleStatements as ATTESTS_SQL is.

## Notes
- Real index_addresses has extra columns and a unique index on address; nothing in that suite inserts into it.
- node_modules was installed with npm ci (untracked, ignored); scratch output is in tmp/.

RUN-COMPLETE 7600691cdd023412a8a9744eb85b35e2
