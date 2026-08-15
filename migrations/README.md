# Legacy manual runbook SQL (NOT auto-applied)

The `.sql` files in this directory are **legacy, manual, one-off runbook scripts**.
They are historical and are **not** read, tracked, checksummed, or applied by the
migration runner.

The runner-tracked migration home is **`src/sql/migrations/`**. That is the only
directory `Database.runMigrations()` scans, records in the `schema_migrations`
ledger, and enforces immutability/checksum on. New migrations go there, tagged
`-- xchain:migration mode=auto|manual` (auto applies at boot; manual applies via
`node src/migrate.js`).

A `manual` migration that code ASSERTS at startup carries one more token on that
same directive line, `deploy-precondition=required`, and is registered in
`Database.STARTUP_ASSERTED_MIGRATIONS`. Both halves are required: without them a
deploy of the asserting code against a database that never applied the migration
crash-loops on boot, which is how a routine indexer deploy took all three mainnet
indexers down on 2026-08-09. The tag is what `xchain-node update` reads out of the
source tree it is about to deploy so it can refuse before recreating the container.

Do not add new migrations here. If a script in this directory still needs to run
against a database, apply it by hand and, if it should become part of the tracked
schema baseline, port it into `src/sql/migrations/` with the appropriate tag.
