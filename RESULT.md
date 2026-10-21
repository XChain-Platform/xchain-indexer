# Lane report: cx-xc-6087

Files touched:
- src/db/database/migration_guards/declared_key_drop.js (unexported declaredKeys, keyEvents)
- src/db/shared.js (unexported STAKE_WEIGHT_NUMERIC)

Notes:
- tmp/line-scope-2026-10-19/dead-exports-indexer-1021.txt is not in the repo, so I re-derived the list: every key exported by the 12 surface files that no other tracked file mentions (word match). Only 3 exports plus 1 kept name came out.
- Kept: contractPubkeyClaimedElsewhere in src/db/contracts/delegation_rotation.js. It is a mixin method called as db.contractPubkeyClaimedElsewhere(...) inside its own module, so unexporting it would break those calls.
- The other names the 27-name list may cover live in files outside Surfaces or are mentioned elsewhere; none were touched.

Tests:
- Full `npm test` fails at load both before and after my change (xchain-vm readonly accessors missing in this environment): 0 run.
- `mocha --no-config` on db_session_sql_mode_pin, db_reconcile_auto_dedup_scope, declared_key_drop_guard, session_sql_mode_guard: 125 passing, 0 failing.
- blockhash_conformance_twin not run (needs the vm setup).

RUN-COMPLETE ebb8580d57fcec2c580693295a029fb6
