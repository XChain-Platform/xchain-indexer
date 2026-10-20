# Migrations

This directory, **`src/sql/migrations/`**, is the only migration home. It is the only
directory `Database.runMigrations()` scans, records in the `schema_migrations`
ledger, and enforces immutability/checksum on. New migrations go there, tagged
`-- xchain:migration mode=auto|manual` (auto applies at boot; manual applies via
`node src/db/migration/migrate.js --file <name>`, the `npm run migrate` script).

An applied migration file is frozen byte for byte: its sha256 is its identity in
`schema_migrations`, so an edit, even to a comment, trips the checksum guard on
every database that ran it unless a reviewed
`Database.MIGRATION_CHECKSUM_REBASELINES` entry ships with it. The HOW TO RUN
comment inside an older file is therefore left as written even where it names a
retired CLI path (`node src/migrate.js`) or the file's pre-rename name. Apply a
manual file with the command above and the file's current name; an auto file needs
no command at all, since the runner applies it at boot.

A `manual` migration that code ASSERTS at startup carries one more token on that
same directive line, `deploy-precondition=required`, and is registered in
`Database.STARTUP_ASSERTED_MIGRATIONS`. Both halves are required: without them a
deploy of the asserting code against a database that never applied the migration
crash-loops on boot, which is how a routine indexer deploy took all three mainnet
indexers down on 2026-08-09. The tag is what `xchain-node update` reads out of the
source tree it is about to deploy so it can refuse before recreating the container.
Each registered file also carries a `Database.MIGRATION_PRECONDITIONS` predicate, so
a database whose boot already built the migration's end state records it as applied
instead of leaving it pending with no ledger row for the deploy check to refuse on.
