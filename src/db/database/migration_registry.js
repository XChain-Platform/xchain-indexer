/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Database class part: migration registry
 *
 * The ledger rename map and its planner, the backdating guard, the deploy-precondition tag
 * and the startup-asserted migration list with its lookups. db/index.js assigns them onto
 * Database as statics.
 *
 ********************************************************************/

// The class itself, for the statics these methods read. db/index.js publishes it before it
// requires any part, so this resolves to the finished class rather than a half-built export.
const Database = require('../index.js');

// One-time ledger rename map (old undated filename -> new dated filename). Three
// legacy migrations predated the dated-prefix convention; renaming them to their
// authored dates restores lexical=chronological apply order. The ledger is keyed
// by filename, so an already-migrated DB has rows under the OLD names; runMigrations
// re-keys those rows to the new names before the applied-vs-pending comparison so
// the renamed files are recognized as applied instead of re-running. File content
// (and therefore checksum) is unchanged by the rename. Fresh DBs have no old rows,
// so they simply apply the files under their new dated names.
const MIGRATION_LEDGER_RENAMES = {
    'add_balances_composite_index.sql':                 '2026-05-30-balances-composite-index.sql',
    'unique_full_column_index_addresses.sql':           '2026-06-03-unique-full-column-index-addresses.sql',
    'add_cross_chain_matches_partial_fill_columns.sql': '2026-06-09-cross-chain-matches-partial-fill-columns.sql',
    // v0.17.0 regtest-first rehearsal (2026-09-11): both files sorted before an
    // already-applied migration (2026-09-08-deploy-deferred-assembly.sql), so they
    // were renamed forward to 2026-09-11- to restore lexical=chronological order.
    // The fleet already recorded them applied under their 2026-09-08- names, so
    // without these entries the rename alone makes both look pending again and the
    // auto path re-applies an ADD COLUMN that is already there.
    '2026-09-08-contract-meta-columns.sql':      '2026-09-11-contract-meta-columns.sql',
    '2026-09-08-cross-chain-btc-chain-id.sql':   '2026-09-11-cross-chain-btc-chain-id.sql',
    // The leg-ordinal migration was authored and committed alongside the two renames
    // just above but was itself left undated-forward: it sorted before
    // 2026-09-11-cross-chain-btc-chain-id.sql, which the fleet had already applied by
    // the time this file merged, so every boot logged a backdating warning and applied
    // it out of its dated position. Renamed past every migration in the tree today so
    // it cannot land behind a frontier again; the fleet already recorded it applied
    // under the old name, so the re-key is required, not optional.
    '2026-09-09-destroys-sends-leg-ordinal.sql': '2026-09-13-destroys-sends-leg-ordinal.sql',
};

// Pure planner for the one-time ledger rename heal. Given the names already recorded
// in schema_migrations, return the {from,to} re-keys to apply: only for legacy names
// that are present and whose dated target is not already recorded. Idempotent - a DB
// already re-keyed (or a fresh DB) yields no operations. Unit-tested directly.
const planLedgerRenames = function(appliedNames){
    const have = new Set(appliedNames);
    const ops  = [];
    for(const [oldName, newName] of Object.entries(Database.MIGRATION_LEDGER_RENAMES)){
        if(have.has(oldName) && !have.has(newName)) ops.push({ from: oldName, to: newName });
    }
    return ops;
};

// Backdating guard for the auto-apply path. Apply order is lexical, so a migration
// added with a date EARLIER than one already applied runs in a different position on
// a fresh database (in its date slot) than on an aged one (after the frontier), and
// the two schemas diverge across the fleet. Given a pending filename and the names
// already in the ledger, return the offending applied name when the pending file
// sorts before the lexical maximum of them, else null. Empty ledger (fresh install)
// never trips. Pure string logic (no DB), unit-tested directly.
//
// Callers must pass this ONLY auto-mode files, and that restriction is the whole
// correctness argument, not an optimization. A mode=manual file legitimately sits
// unapplied behind the frontier for as long as the operator defers it (eleven such
// files ship today), so it is indistinguishable at runtime from a backdated one and
// guarding it would hard-fail `node src/migration/migrate.js` on every aged fleet DB. An auto
// file has no such state: it applies unattended at the first startup that sees it,
// so an unapplied auto file behind the frontier is always newly backdated.
//
// Only DATED ledger names are eligible to be the frontier, and that filter is
// load-bearing rather than tidiness. Four undated migrations shipped before the
// dated-prefix convention; three are re-keyed by MIGRATION_LEDGER_RENAMES, but
// add_controller_bound_token_columns.sql was deleted (7f1142e added it, 1c728c5
// removed it) rather than renamed, so a DB migrated inside that window carries
// that row forever with no heal path. An undated name sorts ABOVE every 2026-*
// name in ASCII ('a' 0x61 > '2' 0x32), so taking the max over raw names would
// make the frontier a garbage maximum that every ordinary new migration sorts
// below, hard-failing `node src/migration/migrate.js` on exactly the aged fleet DBs this
// guard must not break.
const backdatedFrontierViolation = function(pendingName, appliedNames){
    let frontier = null;
    for(const name of (appliedNames || [])){
        const n = String(name);
        if(!/^\d{4}-\d{2}-\d{2}-/.test(n)) continue;
        if(frontier === null || n > frontier) frontier = n;
    }
    if(frontier === null) return null;
    return (String(pendingName) < frontier) ? frontier : null;
};

// The header token that marks a migration as a DEPLOY PRECONDITION: code in this
// tree asserts it at startup, so a build carrying that assertion must not be
// deployed against a database that has not applied it. It rides on the existing
// `-- xchain:migration` directive line, next to `mode=`:
//
//   -- xchain:migration mode=manual deploy-precondition=required
//
// Only a mode=manual file needs it. An `auto` file applies itself at the first
// startup that sees it, so it can never be the missing precondition.
const DEPLOY_PRECONDITION_TAG = 'deploy-precondition=required';

// Migrations this tree ASSERTS at startup: the service refuses to run when the
// target database has not applied them.
//
// WHY THIS LIST EXISTS
// --------------------
// 2026-08-09: deploying 3bc9771 put all three mainnet indexers (BTC, DOGE, LTC)
// into Restarting(1) crash-loops on assertPubkeyColumnIsUncompressedWide, because
// 2026-07-24-pubkeys-widen-uncompressed.sql is mode=manual and had never been
// applied on mainnet. Both halves were individually right - the migration is a COPY
// rebuild under a metadata lock, so it wants the writer quiesced, and the assertion
// is what stops a narrow column silently truncating source_pubkey - but they shipped
// with nothing checking the precondition at DEPLOY time, so the only thing that
// discovered the requirement was a production outage.
//
// The registry is the in-code half of the fix. The machine-readable half is the
// DEPLOY_PRECONDITION_TAG in each listed migration's own header, which the deploy
// tool (xchain-node's MigrationPreconditionService) reads out of the source tree it
// is about to deploy and checks against the target DB's schema_migrations BEFORE the
// container is recreated. test/unit/migration/migration_preconditions.test.js keeps the halves
// in step: every entry here must exist, be mode=manual, and carry the tag.
//
// ADDING A STARTUP ASSERTION: register it here and tag its migration file, or the
// next fleet deploy discovers the requirement the way 2026-08-09 did.
const STARTUP_ASSERTED_MIGRATIONS = [
    {
        file:      '2026-07-24-pubkeys-widen-uncompressed.sql',
        assertion: 'assertPubkeyColumnIsUncompressedWide',
        symptom:   'Fatal indexer error: pubkeys.pubkey holds 66 chars but VARCHAR(130) is required'
    },
    {
        file:      '2026-08-24-validator-rewards-round-qualifier.sql',
        assertion: 'assertRewardUniqueKeyCarriesQualifier',
        symptom:   'Fatal indexer error: validator_rewards.reward_unique does not include round_qualifier'
    },
    {
        file:      '2026-09-12-bridge-tables.sql',
        assertion: 'assertBridgeTablesPresent',
        symptom:   'Fatal indexer error: the bridge tables bridge_transfers, bridge_settlements, policy_snapshots are absent'
    }
];

// Registry lookup by assertion method name. Throws rather than returning undefined:
// an assertion that names a migration nobody registered would otherwise render as
// "--file undefined" in the very error an operator reads mid-outage.
const startupAssertedMigrationFile = function(assertion){
    const entry = Database.STARTUP_ASSERTED_MIGRATIONS.find(m => m.assertion === assertion);
    if(!entry) throw new Error('startupAssertedMigrationFile: ' + assertion +
        ' is not registered in Database.STARTUP_ASSERTED_MIGRATIONS');
    return entry.file;
};

// Does this migration file's header declare itself a deploy precondition?
// Prologue-anchored exactly like migrationMode (the scan stops at the first
// non-blank, non-comment line), so a token buried in body prose or a data literal
// cannot arm it. Pure string logic, unit-tested directly.
//
// Twin: xchain-node/src/services/migration_precondition_service.js carries the same
// parser, because the deploy tool reads these files from a source tree it has only
// cloned and cannot require this module. Keep the two in step.
const migrationDeclaresDeployPrecondition = function(raw){
    const prologue = [];
    for(const line of String(raw).split('\n')){
        const trimmed = line.trim();
        if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
        break;
    }
    return /^\s*--\s*xchain:migration\b[^\n]*\bdeploy-precondition\s*=\s*required\b/im.test(prologue.join('\n'));
};

module.exports = {
    MIGRATION_LEDGER_RENAMES,
    planLedgerRenames,
    backdatedFrontierViolation,
    DEPLOY_PRECONDITION_TAG,
    STARTUP_ASSERTED_MIGRATIONS,
    startupAssertedMigrationFile,
    migrationDeclaresDeployPrecondition,
};
