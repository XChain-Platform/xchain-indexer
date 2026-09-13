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
 * Deploy-precondition contract.
 *
 * A startup assertion that requires an operator-GATED migration is a deploy
 * precondition: build the code, ship it to a database that never applied the
 * migration, and the service crash-loops on boot. That is what took all three
 * mainnet indexers down on 2026-08-09.
 *
 * The fix has two halves that must agree: Database.STARTUP_ASSERTED_MIGRATIONS
 * (what this code asserts) and the `deploy-precondition=required` header tag in
 * each migration file (what the deploy tool can read out of a source tree it has
 * only cloned). This suite is what keeps them in step - it is the only thing
 * standing between a new startup assertion and a repeat of that outage.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

const modeOf = Database.prototype._migrationMode.bind({});
const readMigration = (file) => fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
const allMigrations = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();

describe('Database.migrationDeclaresDeployPrecondition @regression @tier1', function () {

    it('reads the tag off the xchain:migration directive line', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE t MODIFY c VARCHAR(130);'), true);
    });

    it('tolerates spacing around the token', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '--   xchain:migration  mode = manual   deploy-precondition = required\nALTER TABLE t;'), true);
    });

    it('is false for an ordinary tagged migration', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=manual\nALTER TABLE t;'), false);
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(
            '-- xchain:migration mode=auto\nALTER TABLE t;'), false);
    });

    it('is false for an untagged file and for empty input', function () {
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition('ALTER TABLE t;'), false);
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(''), false);
    });

    it('ignores the token once the SQL body has started, so prose or a data literal cannot arm it', function () {
        // Same prologue anchoring as _migrationMode: a comment AFTER the first statement
        // is body text. Without this, a migration that merely DISCUSSES the convention
        // would be read as declaring itself a precondition and block every deploy.
        const raw = 'ALTER TABLE t;\n-- xchain:migration mode=manual deploy-precondition=required\n';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), false);
    });

    it('ignores the token on a comment line that is not the xchain:migration directive', function () {
        const raw = '-- deploy-precondition=required (prose about another file)\n-- xchain:migration mode=manual\nALTER TABLE t;';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), false);
    });

    it('sees the tag through a long license banner (the prologue is unbounded)', function () {
        const banner = Array(30).fill('-- license line').join('\n');
        const raw = banner + '\n\n-- xchain:migration mode=manual deploy-precondition=required\nALTER TABLE t;';
        assert.strictEqual(Database.migrationDeclaresDeployPrecondition(raw), true);
    });
});

describe('Database.STARTUP_ASSERTED_MIGRATIONS @regression @tier1', function () {

    it('registers at least the pubkeys widen that caused the 2026-08-09 fleet halt', function () {
        const files = Database.STARTUP_ASSERTED_MIGRATIONS.map(m => m.file);
        assert.ok(files.includes('2026-07-24-pubkeys-widen-uncompressed.sql'),
            'the migration whose absence crash-looped BTC, DOGE and LTC mainnet must stay registered');
    });

    Database.STARTUP_ASSERTED_MIGRATIONS.forEach(function (entry) {

        it(entry.file + ': the registered migration exists on disk', function () {
            assert.ok(fs.existsSync(path.join(MIG_DIR, entry.file)),
                entry.file + ' is registered as a startup-asserted migration but is not in ' + MIG_DIR +
                '; the deploy guard would look for a row no file can ever produce.');
        });

        it(entry.file + ': carries the deploy-precondition header tag', function () {
            assert.strictEqual(Database.migrationDeclaresDeployPrecondition(readMigration(entry.file)), true,
                entry.file + ' is asserted at startup but does not declare `' + Database.DEPLOY_PRECONDITION_TAG +
                '` in its header, so the deploy tool cannot see the requirement and the next fleet deploy ' +
                'discovers it as a crash-loop.');
        });

        it(entry.file + ': is mode=manual (an auto migration cannot be a missing precondition)', function () {
            assert.strictEqual(modeOf(readMigration(entry.file)), 'manual',
                entry.file + ' is tagged auto, so it applies itself at the first startup that sees it and ' +
                'has no business being a deploy precondition. Either the tag or the registration is wrong.');
        });

        it(entry.file + ': names a real assertion method on Database', function () {
            assert.strictEqual(typeof Database.prototype[entry.assertion], 'function',
                entry.assertion + ' is registered but is not a method on Database.prototype - the registry ' +
                'is describing an assertion that no longer exists.');
        });
    });

    it('every tagged migration file is registered (no tag without an assertion behind it)', function () {
        const registered = new Set(Database.STARTUP_ASSERTED_MIGRATIONS.map(m => m.file));
        const tagged = allMigrations().filter(f => Database.migrationDeclaresDeployPrecondition(readMigration(f)));
        const orphans = tagged.filter(f => !registered.has(f));
        assert.deepStrictEqual(orphans, [],
            'these files declare themselves deploy preconditions but no startup assertion is registered for ' +
            'them, so every deploy would be refused for a requirement this code does not actually have: ' +
            orphans.join(', '));
    });

    it('no mode=auto migration carries the tag', function () {
        const offenders = allMigrations().filter(f => {
            const raw = readMigration(f);
            return Database.migrationDeclaresDeployPrecondition(raw) && modeOf(raw) === 'auto';
        });
        assert.deepStrictEqual(offenders, [], 'auto migrations self-apply and can never be the missing ' +
            'precondition; tagging one makes the deploy guard refuse a deploy it should let through: ' + offenders.join(', '));
    });

    describe('startupAssertedMigrationFile()', function () {
        it('resolves a registered assertion to its migration filename', function () {
            assert.strictEqual(Database.startupAssertedMigrationFile('_assertPubkeyColumnIsUncompressedWide'),
                '2026-07-24-pubkeys-widen-uncompressed.sql');
        });
        it('throws on an unregistered assertion rather than yielding undefined', function () {
            // "node src/migrate.js --file undefined" is worse than useless in the middle
            // of an outage; the lookup must fail where the registry is wrong.
            assert.throws(() => Database.startupAssertedMigrationFile('_assertSomethingNobodyRegistered'),
                /STARTUP_ASSERTED_MIGRATIONS/);
        });
    });
});

describe('_assertPubkeyColumnIsUncompressedWide error text @regression @tier1', function () {

    // Minimal fake connection: the assertion only reads one information_schema row.
    function dbWithColumnWidth(len) {
        return {
            dbName: 'test_indexer',
            transactionConnection: null,
            getConnection: async () => ({
                query: async () => (len === null ? [] : [{ len }]),
                release: async () => {}
            })
        };
    }

    it('names the exact migration file to apply, not just `node src/migrate.js`', async function () {
        // The bare command means "apply every pending manual migration" - nine of them on
        // the mainnet fleet in August 2026, one a DROP COLUMN. Naming the file is what
        // made the 2026-08-09 recovery a scoped --file run instead of a judgement call.
        let message = null;
        try {
            await Database.prototype._assertPubkeyColumnIsUncompressedWide.call(dbWithColumnWidth(66));
        } catch (err) {
            message = err.message;
        }
        assert.ok(message, 'a 66-char column must fail the assertion');
        assert.ok(message.includes('--file 2026-07-24-pubkeys-widen-uncompressed.sql'),
            'the halt message must name the migration; got: ' + message);
    });

    it('passes at the required width and when the column is absent', async function () {
        await Database.prototype._assertPubkeyColumnIsUncompressedWide.call(dbWithColumnWidth(130));
        await Database.prototype._assertPubkeyColumnIsUncompressedWide.call(dbWithColumnWidth(null));
    });
});

describe('_assertRewardUniqueKeyCarriesQualifier @regression @tier1', function () {

    const QUALIFIER_FILE = '2026-08-24-validator-rewards-round-qualifier.sql';

    // Minimal fake connection: the assertion reads one row of two counts off
    // information_schema.statistics. `rows` is what that query answers.
    function dbWithIndexShape(rows) {
        let seenSql = null, seenParams = null;
        return {
            dbName: 'test_indexer',
            transactionConnection: null,
            seen: () => ({ sql: seenSql, params: seenParams }),
            getConnection: async () => ({
                query: async (sql, params) => { seenSql = sql; seenParams = params; return rows; },
                release: async () => {}
            })
        };
    }
    const run = (db) => Database.prototype._assertRewardUniqueKeyCarriesQualifier.call(db);
    // The live shape the assertion reads: table present, qualifier column present, a
    // reward_unique index of `key_columns` columns, `qualifier_columns` of which is the
    // qualifier as part of a UNIQUE index.
    const shape = (over) => [Object.assign(
        { reward_table: 1, qualifier_column: 1, key_columns: 5, qualifier_columns: 1 }, over)];

    it('HALTS on the four-column key: the index exists and carries no qualifier', async function () {
        // The state the migration exists to converge, and the one the drift reconciler
        // cannot heal: the columns were ADDed at boot, reward_unique was not rebuilt, and
        // the qualifier-aware writers would re-collapse two distinct archive rewards.
        let message = null;
        try { await run(dbWithIndexShape(shape({ key_columns: 4, qualifier_columns: 0 }))); }
        catch (err) { message = err.message; }
        assert.ok(message, 'a reward_unique without round_qualifier must fail the assertion');
        assert.match(message, /reward_unique/);
        assert.match(message, /round_qualifier/);
        assert.ok(message.includes('--file ' + QUALIFIER_FILE),
            'the halt message must name the migration to apply; got: ' + message);
    });

    it('HALTS when a same-named index carries the qualifier but is NOT unique', async function () {
        // A non-unique reward_unique deduplicates nothing, so the qualifier sitting in it
        // is no protection at all. The count already excludes non_unique rows; this is the
        // behaviour that exclusion buys.
        await assert.rejects(
            () => run(dbWithIndexShape(shape({ key_columns: 5, qualifier_columns: 0 }))),
            /reward_unique does not include round_qualifier/);
    });

    it('HALTS when the qualifier COLUMN is missing from an existing table (errno 1054 mid-block)', async function () {
        let message = null;
        try {
            await run(dbWithIndexShape(shape({ qualifier_column: 0, key_columns: 4, qualifier_columns: 0 })));
        } catch (err) { message = err.message; }
        assert.ok(message, 'a table with no round_qualifier column must fail the assertion');
        assert.match(message, /no round_qualifier column/);
        assert.ok(message.includes('--file ' + QUALIFIER_FILE), 'got: ' + message);
    });

    it('passes on the converged five-column key', async function () {
        await run(dbWithIndexShape(shape()));
    });

    it('passes when validator_rewards does not exist yet (fresh install)', async function () {
        await run(dbWithIndexShape(shape({ reward_table: 0, qualifier_column: 0, key_columns: 0, qualifier_columns: 0 })));
        await run(dbWithIndexShape([]));
        await run(dbWithIndexShape(null));
    });

    it('passes when the table has the column but no reward_unique index to compare', async function () {
        await run(dbWithIndexShape(shape({ key_columns: 0, qualifier_columns: 0 })));
    });

    it('passes when a count is unreadable rather than halting on an answer it cannot read', async function () {
        await run(dbWithIndexShape(shape({ reward_table: null })));
        await run(dbWithIndexShape(shape({ qualifier_column: null })));
        await run(dbWithIndexShape(shape({ key_columns: null })));
        await run(dbWithIndexShape(shape({ qualifier_columns: null })));
        await run(dbWithIndexShape(shape({ key_columns: 'not-a-number', qualifier_columns: 0 })));
        await run(dbWithIndexShape(shape({ qualifier_columns: 'not-a-number' })));
    });

    it('reads the live INDEX shape, unique-only, bound once on the database name', async function () {
        // A column-level test alone would pass on exactly the database this guard exists
        // for, so the index shape is what gates it; the column is the loud half.
        const db = dbWithIndexShape(shape());
        await run(db);
        const { sql, params } = db.seen();
        assert.match(sql, /information_schema\.statistics/i);
        assert.match(sql, /information_schema\.columns/i);
        assert.match(sql, /information_schema\.tables/i);
        assert.match(sql, /index_name = 'reward_unique'/);
        assert.match(sql, /column_name = 'round_qualifier'/);
        assert.match(sql, /non_unique = 0/);
        assert.strictEqual((sql.match(/\?/g) || []).length, 1);
        assert.deepStrictEqual(params, ['test_indexer']);
    });

    it('releases the connection it took, on the halt path too', async function () {
        let released = 0;
        const db = {
            dbName: 'test_indexer',
            transactionConnection: null,
            getConnection: async () => ({
                query: async () => shape({ key_columns: 4, qualifier_columns: 0 }),
                release: async () => { released++; }
            })
        };
        await assert.rejects(() => run(db), /reward_unique/);
        assert.strictEqual(released, 1, 'a halting assertion must not leak the pool connection');
    });
});
