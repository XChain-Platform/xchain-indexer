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
 * XChain Indexer - Database class part: migration runner
 *
 * The ledgered migration runner behind runMigrations: the advisory lock, the ledger rename
 * heal, the checksum guard, the precondition and mode gates, and the apply of each file.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { getLogger } = require('../../observability/index.js');
const { CONFIG_ENV } = require('../../config.js');
// The class itself, for the statics these methods read. db/index.js publishes it before it
// requires any part, so this resolves to the finished class rather than a half-built export.
const Database = require('../index.js');

// Targeted rollout: a name that matches no committed migration is almost
// always a typo. Fail loudly (silently applying nothing would look like a
// successful no-op run) and list what IS available.
function assertOnlyTargetsKnown(only, files, dir){
    if(only){
        if(only.size === 0)
            throw new Error('runMigrations: opts.only was provided but empty; pass at least one migration filename.');
        const known   = new Set(files);
        const unknown = [...only].filter(n => !known.has(n));
        if(unknown.length)
            throw new Error('runMigrations: --file target(s) not found in ' + dir + ': ' + unknown.join(', ') +
                '. Available: ' + files.join(', '));
    }
}

// runMigrationsInner, inside the migration lock: create the ledger, heal the legacy renames,
// then settle each migration file in lexical order.
async function applyPendingMigrations(self, conn, files, ctx){
    await self.ensureMigrationsLedger(conn);
    const appliedRows   = await conn.query('SELECT name, checksum FROM schema_migrations');
    const appliedByName = new Map(appliedRows.map(r => [r.name, r.checksum]));

    // One-time ledger rename heal: three legacy files were renamed from
    // undated to dated names. The ledger is keyed by filename, so an
    // already-migrated DB still records them under the old names. Re-key
    // those rows to the new names (durably, in place) before the comparison
    // below, so the renamed files register as applied instead of re-running.
    for(const { from, to } of Database.planLedgerRenames(appliedByName.keys())){
        await conn.query('UPDATE schema_migrations SET name = ? WHERE name = ?', [to, from]);
        appliedByName.set(to, appliedByName.get(from));
        appliedByName.delete(from);
        getLogger().info('runMigrations: re-keyed ledger row ' + from + ' -> ' + to + ' (legacy migration renamed to dated form).');
    }

    for(const file of files) await migrateFile(self, conn, file, appliedByName, ctx);
}

// One migration file: the scope and naming checks, then the checksum guard for an applied
// file, or the gates and the apply for a pending one.
async function migrateFile(self, conn, file, appliedByName, ctx){
    const { dir, only, includeManual, result } = ctx;
    // Scoped run (--file): touch ONLY the targeted file(s). Report an
    // untargeted-but-unapplied file as pending so the operator still sees
    // remaining work, then leave it entirely alone: no dated-prefix check,
    // no checksum guard, no apply. A per-file rollout must never be blocked
    // by an unrelated migration's state elsewhere in the tree (#3874).
    if(only && !only.has(file)){
        if(!appliedByName.has(file)) result.pending.push(file);
        return;
    }
    // Freeze the dated-prefix convention in code: apply order is lexical
    // (readdirSync().sort()), so every migration filename must start with a
    // YYYY-MM-DD- prefix to apply in authorship order. The three legacy
    // undated files were renamed to dated form, so no exemption remains.
    if(!/^\d{4}-\d{2}-\d{2}-/.test(file)){
        throw new Error('runMigrations: migration "' + file + '" is not dated. Every migration ' +
            'filename must start with a YYYY-MM-DD- prefix so it applies in authorship order ' +
            '(apply order is lexical). Rename it with the authored date.');
    }
    const raw      = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(raw).digest('hex');

    if(appliedByName.has(file)){
        await checkAppliedChecksum(conn, file, checksum, appliedByName, includeManual);
        return;
    }

    const mode = self.migrationMode(raw);

    if(await gateUnappliedMigration(self, conn, file, checksum, mode, result, includeManual)) return;

    // Backdating guard: the dated-prefix check above freezes the NAMING
    // convention, but nothing stopped a new file from being dated before a
    // migration the fleet already applied. Lexical apply order then puts it
    // in its date slot on a fresh DB and after the frontier on an aged one,
    // diverging the two schemas. `frontier` is the ledger state at run start
    // (appliedByName is not written during the loop), so files applied by
    // THIS run never advance it and a long-offline node catching up is fine.
    // Auto files only - see Database.backdatedFrontierViolation for why a
    // deferred mode=manual file cannot be told apart from a backdated one.
    if(mode === 'auto') guardBackdatedFrontier(file, appliedByName, includeManual);

    await applyMigrationFile(self, conn, file, raw, checksum, mode, result);
}

// An applied file whose content changed: heal a pinned reviewed rebaseline, else fail closed
// on the operator path and in strict mode, and log loudly on a passive startup.
async function checkAppliedChecksum(conn, file, checksum, appliedByName, includeManual){
    if(appliedByName.get(file) !== checksum){
        // Deliberate one-off rebaselines: an applied file whose only change
        // was a reviewed non-executable edit (e.g. a mode retag) may be
        // rebaselined here so fleets that recorded the old checksum heal
        // in place instead of failing every operator migrate run forever.
        // Both hashes are pinned, so any OTHER edit still trips the guard.
        // `from` may be a single hash or a list: the same reviewed edit
        // can supersede several historical file revisions, and each DB
        // recorded whichever revision it applied first. Normalize to a
        // list so every recorded predecessor heals to the current hash.
        const rebase   = Database.MIGRATION_CHECKSUM_REBASELINES[file];
        const fromList = rebase ? [].concat(rebase.from) : [];
        if(rebase && fromList.includes(appliedByName.get(file)) && checksum === rebase.to){
            await conn.query('UPDATE schema_migrations SET checksum = ? WHERE name = ?', [checksum, file]);
            getLogger().info('runMigrations: rebaselined checksum for ' + file + ' (reviewed retag, executable SQL unchanged).');
            return;
        }
        // Migrations are immutable once applied. A changed checksum means
        // someone edited an applied file, so the DB is now on a schema that
        // diverges from what the committed file describes.
        const msg = 'runMigrations: ' + file + ' was already applied but its content CHANGED (checksum mismatch: recorded ' +
            appliedByName.get(file) + ', current ' + checksum + '). Migrations are immutable once applied.';
        // Operator path (`node src/migration/migrate.js`, includeManual) and opt-in strict
        // mode fail closed so a diverged schema is caught in CI / by an operator
        // instead of silently continuing. Default auto-startup stays non-fatal
        // (console.error, not warn) to avoid a surprise fleet-wide boot failure.
        if(includeManual || CONFIG_ENV.MIGRATION_STRICT_CHECKSUM === '1'){
            // Tailor the remedy to which branch actually fired. The operator path
            // (includeManual, `node src/migration/migrate.js`) ALWAYS fails closed by design, so
            // MIGRATION_STRICT_CHECKSUM has no effect there - telling the operator to
            // clear it just loops them back to the same error. Only the passive
            // startup path opted into strict mode via MIGRATION_STRICT_CHECKSUM=1 can
            // actually be downgraded by clearing it.
            const hint = includeManual
                ? ' This operator run always fails closed (MIGRATION_STRICT_CHECKSUM has no' +
                  ' effect here). Either revert ' + file + ' to the content matching the' +
                  ' recorded checksum, or - if the edit was reviewed and changed no' +
                  ' executable SQL - add a pinned Database.MIGRATION_CHECKSUM_REBASELINES' +
                  ' entry mapping the recorded hash to the current one.'
                : ' Review manually (set MIGRATION_STRICT_CHECKSUM=0 / omit to downgrade to a non-fatal log).';
            throw new Error(msg + hint);
        }
        getLogger().error(msg + ' Continuing on the diverged schema - review manually.');
    }
}

// A pending file the precondition baselines or the mode gate defers: true when it was settled
// here and must not be applied.
async function gateUnappliedMigration(self, conn, file, checksum, mode, result, includeManual){
    // Precondition gate: a migration listed in MIGRATION_PRECONDITIONS is
    // applicable only to a schema in a particular shape, and running it on
    // any other shape destroys data rather than converting it. Evaluate the
    // predicate against the LIVE schema and, when it says the migration does
    // not apply, record it as applied WITHOUT executing a statement.
    //
    // Baselining rather than merely skipping is what makes it stick: a skip
    // leaves the file pending forever, so every later blanket run re-enters
    // this branch and one runner change or one direct-SQL apply puts the
    // hazard back. The ledger row states what is already true - the end
    // state this migration exists to produce holds on this database.
    //
    // It runs BEFORE the mode gate deliberately, so an unattended startup
    // baselines a pending manual migration and the hazard is gone before an
    // operator ever reaches for `npm run migrate`.
    const preconditionSkip = await self.migrationPreconditionSkip(file, conn);
    if(preconditionSkip){
        await conn.query(
            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
            [file, checksum, mode]
        );
        result.baselined.push(file);
        getLogger().info('runMigrations: BASELINED ' + file + ' (recorded as applied, no statement run): ' + preconditionSkip);
        return true;
    }

    if(mode !== 'auto' && !includeManual){
        getLogger().info('runMigrations: PENDING (gated, mode=' + mode + '): ' + file + ' - apply with `node src/migration/migrate.js`.');
        result.pending.push(file);
        return true;
    }
    return false;
}

// The backdating guard for an auto file (see the note where migrateFile calls it).
function guardBackdatedFrontier(file, appliedByName, includeManual){
    const frontier = Database.backdatedFrontierViolation(file, appliedByName.keys());
    if(frontier){
        const msg = 'runMigrations: ' + file + ' is dated BEFORE already-applied migration ' + frontier +
            ', so it would run in a different position here than on a fresh database and diverge the schema. ' +
            'Rename it with a date after ' + frontier + '.';
        // Same dual-mode contract as the checksum guard above: the operator
        // path and opt-in strict mode fail closed, passive startup logs and
        // proceeds so a backdated commit cannot black-start the fleet.
        if(includeManual || CONFIG_ENV.MIGRATION_STRICT_CHECKSUM === '1') throw new Error(msg);
        getLogger().error(msg + ' Applying it anyway at this position - review manually.');
    }
}

// Split, guard and apply one pending file, then record it in the ledger.
async function applyMigrationFile(self, conn, file, raw, checksum, mode, result){
    // Quote-aware split into statements: strips `--` line comments and
    // breaks on ';' only outside quoted strings, so a ';' in a comment
    // header or inside a string literal never terminates a statement, and
    // destructiveAutoStatement classifies real statements not fragments.
    const statements = self.splitSqlStatements(raw);
    // Destructive-DDL guard: the mode tag is a human declaration; this scan is
    // the machine check behind it. A file tagged `auto` that contains DDL able
    // to lose or rename data must NEVER run unattended at startup (nor slip
    // through migrate.js under the wrong tag) - block startup with an
    // actionable error instead of executing it against every validator's DB.
    if(mode === 'auto'){
        const offender = self.destructiveAutoStatement(statements);
        if(offender){
            throw new Error('runMigrations: ' + file + ' is tagged mode=auto but contains destructive DDL: "' +
                offender.slice(0, 160) + (offender.length > 160 ? '...' : '') + '". ' +
                'Re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src/migration/migrate.js`.');
        }
    }
    getLogger().info('runMigrations: applying ' + file + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
    try {
        for(const stmt of statements){ await conn.query(stmt); }
    } catch(err){
        // Schema is now in an unknown state - block startup rather than run on.
        getLogger().error('runMigrations: FAILED applying ' + file + ': ' + (err && err.message));
        throw err;
    }
    await conn.query(
        'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
        [file, checksum, mode]
    );
    result.applied.push(file);
    getLogger().info('runMigrations: applied ' + file);
}

module.exports = {

    async runMigrationsInner(opts = {}){
        const includeManual = !!opts.includeManual;
        const only          = (opts.only == null) ? null
            : new Set([].concat(opts.only).map(s => String(s).trim()).filter(Boolean));
        const dir           = path.join(__dirname, '..', '..', 'sql', 'migrations');
        const result        = { applied: [], pending: [], baselined: [], lockSkipped: false };

        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(e){ return result; }   // no migrations dir → nothing to do
        if(!files.length) return result;

        assertOnlyTargetsKnown(only, files, dir);

        const lockName = 'xchain_migrate_' + this.dbName;
        let conn = await this.getConnection();
        try {
            // DB-scoped advisory lock so two processes don't apply concurrently. GET_LOCK
            // is server-global, so the name is namespaced by dbName (the shared MariaDB on
            // a combined box hosts many indexer DBs).
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                getLogger().warn('runMigrations: could not acquire lock ' + lockName + ' (another process is migrating). Skipping this run.');
                // #3162: flag the skip so callers do NOT read the empty applied/pending shape as
                // a completed run. The operator CLI must not print "done" and exit 0 when nothing
                // was even examined - the schema may still be un-migrated.
                result.lockSkipped = true;
                return result;
            }
            try {
                await applyPendingMigrations(this, conn, files, { dir, only, includeManual, result });
            } finally {
                try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch(_){}
            }
        } finally {
            try { await conn.release(); } catch(_){}
        }

        if(result.applied.length) getLogger().info('runMigrations: ' + result.applied.length + ' migration(s) applied to ' + this.dbName + '.');
        if(result.pending.length) getLogger().info('runMigrations: ' + result.pending.length + ' manual migration(s) pending for ' + this.dbName + ' - run `node src/migration/migrate.js` to apply.');
        return result;
    },

};
