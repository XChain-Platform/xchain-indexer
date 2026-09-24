'use strict';

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
 * Backdating guard, object-level half: out of order vs actually divergent.
 *
 * The lexical guard fires on any late-dated migration. Two migrations only diverge a
 * schema when the objects they touch overlap, so a file that jumps migrations touching
 * other tables entirely is out of order and harmless, and reporting it with the same
 * words as a real divergence trains an operator to ignore both. These tests pin the
 * discrimination in both directions, and pin that anything unprovable stays loud.
 *
 ********************************************************************/

const { assert, fs, path, Database, requireWithFreshConfig, DB_PATH,
        BRIDGE_TABLES_PROBE, bridgeTablesPresent } = require('./helpers/migration_fixtures.js');
const { migrationTouchedTables, reorderVerdict } = require('../../../../src/db/database/migration_reorder.js');

const crypto  = require('crypto');
const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');

const sha256     = (s) => crypto.createHash('sha256').update(s).digest('hex');
const allFiles   = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
const readMig    = (f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
const ledgerOfAll = () => new Map(allFiles().map(f => [f, sha256(readMig(f))]));
const tablesOfFile = (f) => migrationTouchedTables(
    Database.prototype.splitSqlStatements.call(Database.prototype, readMig(f)));

// The runner against a ledger of our choosing, with every live-schema question answered
// the way the sibling runner harness answers it. Deleting a name from the ledger is what
// makes that file pending behind the rest, which is the backdating shape.
async function runAgainst(ledger, opts, DatabaseClass = Database) {
    const logged  = [];
    const applied = [];
    const conn = {
        query: async function (sql, params) {
            if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { applied.push(params[0]); return {}; }
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) return {};
            return [];
        },
        release: async function () {},
    };
    const db = {
        dbName: 'test_indexer',
        transactionConnection: null,
        getConnection: async () => conn,
        ensureMigrationsLedger: async () => {},
        runMigrationsInner:       DatabaseClass.prototype.runMigrationsInner,
        migrationMode:            DatabaseClass.prototype.migrationMode,
        migrationPreconditionSkip: DatabaseClass.prototype.migrationPreconditionSkip,
        splitSqlStatements:       DatabaseClass.prototype.splitSqlStatements,
        stripSqlLineComments:     DatabaseClass.prototype.stripSqlLineComments,
        destructiveAutoStatement: DatabaseClass.prototype.destructiveAutoStatement,
        isIdRepairUpdate:         DatabaseClass.prototype.isIdRepairUpdate,
    };
    const realLog = console.log, realErr = console.error, realWarn = console.warn;
    console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
    try {
        const result = await DatabaseClass.prototype.runMigrationsInner.call(db, opts || {});
        return { logged, applied, result, threw: null };
    } catch (err) {
        return { logged, applied, result: null, threw: err };
    } finally {
        console.log = realLog; console.error = realErr; console.warn = realWarn;
    }
}


describe('migration reorder attribution @regression @tier1', function () {
    it('reads the target table off each recognized DDL form', function () {
        assert.deepStrictEqual(migrationTouchedTables([
            'ALTER TABLE `XChain_Indexer`.`Tokens` ADD COLUMN x INT',
            'CREATE INDEX IF NOT EXISTS ix ON sends (a)',
            'DROP INDEX ix ON destroys',
            'CREATE TABLE IF NOT EXISTS bridge_transfers (id INT)',
        ]), { tables: ['bridge_transfers', 'destroys', 'sends', 'tokens'], opaque: null });
    });

    it('follows a foreign key to the table it references', function () {
        assert.deepStrictEqual(
            migrationTouchedTables(['ALTER TABLE sends ADD FOREIGN KEY (a) REFERENCES addresses (id)']).tables,
            ['addresses', 'sends']);
    });

    // The whitelist is the safety property: an unrecognized form must never be scored as
    // touching nothing, because "touches nothing" is what makes a reorder look harmless.
    it('refuses any statement whose tables cannot be read off the prefix', function () {
        for (const stmt of [
            'UPDATE tokens t SET x = (SELECT y FROM issues)',   // subquery source the prefix does not name
            'INSERT INTO tokens SELECT * FROM issues',          // ditto
            'SET @s = \'DROP TABLE balances\'',                 // dynamic SQL staging
            'CALL rebuild_everything()',                        // a body the scanner cannot see
            '/*!50000 DROP TABLE balances */',                  // executed by the server, stripped by a naive scan
        ]) {
            const seen = migrationTouchedTables([stmt]);
            assert.ok(seen.opaque, 'expected opaque for: ' + stmt);
            assert.deepStrictEqual(seen.tables, [], 'an opaque statement must not contribute tables');
        }
    });

    it('lets a session-variable SET through as touching nothing', function () {
        assert.deepStrictEqual(migrationTouchedTables(['SET NAMES utf8mb4']), { tables: [], opaque: null });
    });
});


describe('migration reorder verdict @regression @tier1', function () {
    const pending = { file: 'a.sql', statements: ['ALTER TABLE state_tree_roots ADD INDEX ix (block_index)'] };

    it('calls a disjoint reorder harmless and names what it touched', function () {
        const v = reorderVerdict(pending, [
            { file: 'b.sql', statements: ['ALTER TABLE tokens ADD COLUMN x INT'] },
            { file: 'c.sql', statements: ['ALTER TABLE destroys ADD COLUMN y INT'] },
        ]);
        assert.strictEqual(v.divergent, false);
        assert.deepStrictEqual(v.tables, ['state_tree_roots']);
        assert.deepStrictEqual(v.shared, []);
    });

    it('calls an overlapping reorder divergent and names the shared table', function () {
        const v = reorderVerdict(pending, [
            { file: 'b.sql', statements: ['ALTER TABLE tokens ADD COLUMN x INT'] },
            { file: 'c.sql', statements: ['CREATE INDEX ix2 ON state_tree_roots (chain)'] },
        ]);
        assert.strictEqual(v.divergent, true);
        assert.deepStrictEqual(v.shared, [{ file: 'c.sql', tables: ['state_tree_roots'] }]);
    });

    it('calls an unreadable jumped migration divergent rather than assuming it is disjoint', function () {
        const v = reorderVerdict(pending, [{ file: 'deleted.sql', statements: null }]);
        assert.strictEqual(v.divergent, true);
        assert.strictEqual(v.opaque[0].file, 'deleted.sql');
    });

    it('calls an opaque statement on either side divergent', function () {
        const backfill = ['UPDATE issues SET a = (SELECT b FROM tokens)'];
        assert.strictEqual(reorderVerdict(pending, [{ file: 'b.sql', statements: backfill }]).divergent, true);
        assert.strictEqual(reorderVerdict({ file: 'a.sql', statements: backfill },
            [{ file: 'b.sql', statements: ['ALTER TABLE tokens ADD COLUMN x INT'] }]).divergent, true);
    });
});


// The shape this exists for, driven through the real runMigrationsInner against the real
// migrations directory. On the three testnet indexer DBs
// 2026-09-12-state-tree-roots-block-index-idx.sql applied AFTER the two migrations it
// sorts before; deleting exactly that name from a full ledger reproduces that database.
describe('runMigrations() reorder discrimination @regression @tier1', function () {
    const HARMLESS = '2026-09-12-state-tree-roots-block-index-idx.sql';
    // The jumped pair from the same window, kept as an assertion rather than a comment so a
    // later migration landing between them cannot silently change what this case tests.
    const REQUIRED_JUMPED = ['2026-09-12-token-bridge-fields.sql', '2026-09-13-destroys-sends-leg-ordinal.sql'];
    const jumpedFiles = () => allFiles().filter(f => f > HARMLESS);

    it('the audited pair really is disjoint at the object level', function () {
        const mine = tablesOfFile(HARMLESS);
        assert.deepStrictEqual(mine.tables, ['state_tree_roots']);
        const jumped = jumpedFiles();
        for (const required of REQUIRED_JUMPED) {
            assert.ok(jumped.includes(required), required + ' must remain among the jumped migrations');
        }
        for (const other of jumped) {
            const theirs = tablesOfFile(other);
            assert.strictEqual(theirs.opaque, null, other + ' became unattributable');
            assert.deepStrictEqual(theirs.tables.filter(t => mine.tables.includes(t)), [],
                other + ' now shares a table with ' + HARMLESS);
        }
    });

    it('does not fail the operator path for a reorder it can prove harmless', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(HARMLESS);
        const { logged, applied, result, threw } = await runAgainst(ledger, { includeManual: true });
        assert.strictEqual(threw, null, 'a provably harmless reorder must not fail closed: ' + (threw && threw.message));
        assert.ok(applied.includes(HARMLESS), 'the migration must still apply');
        const line = logged.find(l => /PROVABLY HARMLESS/.test(l));
        assert.ok(line, 'expected the harmless verdict to be recorded: ' + logged.join(' | '));
        assert.ok(line.includes('state_tree_roots'), 'the verdict must name the objects it checked: ' + line);
        assert.ok(!logged.some(l => /diverge the schema/.test(l)), 'a harmless reorder must not claim divergence');
    });

    it('records the checked reorder in the run result, not only in the log', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(HARMLESS);
        const { result } = await runAgainst(ledger, { includeManual: true });
        assert.deepStrictEqual(result.reordered, [{
            file:      HARMLESS,
            frontier:  jumpedFiles()[jumpedFiles().length - 1],
            divergent: false,
            tables:    ['state_tree_roots'],
            shared:    [],
            opaque:    [],
        }]);
    });

    it('a current ledger records no reorder at all', async function () {
        const { result } = await runAgainst(ledgerOfAll(), { includeManual: true });
        assert.deepStrictEqual(result.reordered, []);
    });
});


// The other direction: the loud path must survive the new discrimination unchanged.
// 2026-06-09-cross-chain-matches-partial-fill-columns.sql is the earliest auto migration
// and five later ones also alter cross_chain_matches, so held back it is a genuine
// same-object reorder.
describe('runMigrations() keeps shouting about a divergent reorder @regression @tier1', function () {
    const DIVERGENT = '2026-06-09-cross-chain-matches-partial-fill-columns.sql';

    it('the chosen file really does share an object with something it sorts before', function () {
        const mine  = tablesOfFile(DIVERGENT);
        const after = allFiles().filter(f => f > DIVERGENT);
        const hits  = after.filter(f => {
            const t = tablesOfFile(f);
            return t.opaque === null && t.tables.some(x => mine.tables.includes(x));
        });
        assert.ok(hits.length, 'expected a same-table later migration; got none');
    });

    it('the operator path still fails closed, and the error names the shared object', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(DIVERGENT);
        const { threw } = await runAgainst(ledger, { includeManual: true });
        assert.ok(threw, 'a divergent reorder must still refuse to apply on the operator path');
        assert.match(threw.message, /dated BEFORE already-applied migration/);
        assert.ok(threw.message.includes('cross_chain_matches'),
            'the error must name the object that would differ: ' + threw.message);
    });

    it('opt-in strict mode still fails closed on the passive path', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(DIVERGENT);
        const prev = process.env.MIGRATION_STRICT_CHECKSUM;
        process.env.MIGRATION_STRICT_CHECKSUM = '1';
        try {
            const { threw } = await runAgainst(ledger, {}, requireWithFreshConfig(DB_PATH));
            assert.ok(threw && /dated BEFORE already-applied migration/.test(threw.message));
        } finally {
            if (prev === undefined) delete process.env.MIGRATION_STRICT_CHECKSUM;
            else process.env.MIGRATION_STRICT_CHECKSUM = prev;
        }
    });

    it('default passive startup still logs loudly, applies, and flags the result divergent', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(DIVERGENT);
        const { logged, applied, result, threw } = await runAgainst(ledger, {});
        assert.strictEqual(threw, null, 'passive startup must not black-start the fleet');
        assert.ok(applied.includes(DIVERGENT), 'the file still applies on the passive path');
        const line = logged.find(l => /dated BEFORE already-applied migration/.test(l));
        assert.ok(line, 'the divergence must still be reported: ' + logged.join(' | '));
        assert.ok(line.includes('cross_chain_matches'), 'the log must name the object: ' + line);
        assert.strictEqual(result.reordered.length, 1);
        assert.strictEqual(result.reordered[0].divergent, true);
        assert.ok(result.reordered[0].shared.length, 'the shared files must be recorded');
    });
});
