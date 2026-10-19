# Lane report: cx-xc-5712

## Files touched
- test/unit/api/rpc/attest_batches.test.js: index_statuses, attests, actions, transactions, index_transactions now come from src/sql via a local loadDdl (reuses mysqlDdlToSqlite from test/helpers/sqlAnchorDb.js, plus ENUM, CHARACTER SET, index prefix and index-name rewrites). Inserts now name their columns.
- test/unit/rollback/rollback.test/maturity_escrow_release_reversal.test.js: index_addresses, index_tickers, unstakes, contract_unstakes, credits, escrows from src/sql the same way. Inserts name columns and supply signing_pubkey_id, which the real schema requires.
- test/integration/attest_relay_identity.test/helpers/relay_identity_db.js: the hand-written index_addresses stand-in is replaced by src/sql/index_addresses.sql (comments stripped with the product stripper, as for attests.sql).
- test/unit/bridge/db_xbridge_writers.test.js and test/unit/list_share/list_share_tables.test.js: unchanged. They already read src/sql DDL and only parse it (compared against migrations), so they count as parser tests.

## Tests
- Verify grep (no CREATE TABLE in the three named files): pass.
- Direct mocha run of the five surface test files: 34 passing, 0 failing, 10 pending (integration relay identity suite self-skips: no TEST_DB_PASS / database here).
- `npm test` could not complete in this container, and fails the same way on the untouched base commit: sibling checkouts are missing (Cannot find module 'xchain-vm', and ../xchain-documentation/protocol/test-vectors/list_share.json), so mocha aborts at load before any test runs. No full-suite pass/fail count is available. The orchestrator should rerun `npm test` in an environment with the sibling repos.
- The relay identity change is untested against a live MariaDB (loads cleanly, suite skipped).

## Notes
- Local loader is duplicated in the two unit files because the shared helpers are outside Surfaces.

RUN-COMPLETE 00daf51e2da63795189928e476ef6de8
