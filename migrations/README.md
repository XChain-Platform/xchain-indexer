# Legacy manual runbook SQL (NOT auto-applied)

The `.sql` files in this directory are **legacy, manual, one-off runbook scripts**.
They are historical and are **not** read, tracked, checksummed, or applied by the
migration runner.

The runner-tracked migration home is **`src/sql/migrations/`**. That is the only
directory `Database.runMigrations()` scans, records in the `schema_migrations`
ledger, and enforces immutability/checksum on. New migrations go there, tagged
`-- xchain:migration mode=auto|manual` (auto applies at boot; manual applies via
`node src/migrate.js`).

Do not add new migrations here. If a script in this directory still needs to run
against a database, apply it by hand and, if it should become part of the tracked
schema baseline, port it into `src/sql/migrations/` with the appropriate tag.
