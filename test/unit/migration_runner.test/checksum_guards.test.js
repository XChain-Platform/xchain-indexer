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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers the gate that decides whether a migration runs unattended at startup:
 * migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const { assert, fs, path, Database, BRIDGE_TABLES_PROBE, bridgeTablesPresent } = require('./helpers/migration_fixtures.js');


const crypto  = require('crypto');
const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
// The two legacy migrations that were renamed AND carry their own filename in
// a HOW TO RUN comment: the rename edited that comment, the ledger rename heal carried
// the pre-rename checksum across, and every prod indexer logged `content CHANGED` for
// them on every start. Pin the predecessor hashes so a real migration edit is loud again.
const XC805 = {
    '2026-06-03-unique-full-column-index-addresses.sql': [
        '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e',
        '8193fe4eca04ac802b5963a7f3b100bf2b3f3103aaeb18e8eb5ff88b8f5f557d',
    ],
    '2026-06-09-cross-chain-matches-partial-fill-columns.sql': [
        '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602',
        '7fe66226c936023b72121c24fb3cfbea5bd4e52e70964542a6617f12b2a74451',
    ],
};

// The three files the 758fc1db internal-reference scrub caught. Their entries were
// missing until 2026-08-26, and the cost was not the log noise: `node src/migration/migrate.js`
// fails CLOSED on a checksum mismatch, so the first of these made the entire pending
// manual backlog unappliable on every aged testnet/regtest host.
const SCRUBBED = {
    '2026-07-16-mirror-twin-bigint-unsigned-align.sql': '1d981cd5d128c2ec8de391289b11fdc43932f65ee5d3fd8a61c32e7b01be0569',
    '2026-07-26-tokens-backfill-lock-mint-supply.sql':  '03ec334fdfafd207d5ca7d39887422175ab0ed9f83947c21a6d30c2391419215',
    '2026-07-29-state-checkpoints-uq-chain-seq.sql':    '05dfd2ef7d246929a451521aa7c4c6e0f21faf019dd06f1f16384a450675267c',
};

// The invariant that JUSTIFIES those three rebaselines, pinned so it cannot rot: a
// rebaseline is only legitimate while the edit was comment-only. Hashing the
// comment-stripped residue makes a future edit to the STATEMENTS fail here loudly,
// instead of silently riding a heal entry that no longer describes the change.
const EXECUTABLE_RESIDUE = {
    '2026-07-16-mirror-twin-bigint-unsigned-align.sql': 'f704908ec8c87fe8faa43e991df277e8a0c303a628add80c7a809a723f04da34',
    '2026-07-26-tokens-backfill-lock-mint-supply.sql':  '554ee749cb1836ced104797186ff4ae5e048d07ac528898be25def30b3bcf273',
    '2026-07-29-state-checkpoints-uq-chain-seq.sql':    'dd0a8cf50b0c0f03ebb4f517003275e11a8843ded0e144a5041ef138a91b94cc',
};


describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {
    it('every rebaseline pins a `to` and one or more distinct 64-hex sha256 `from` values', function () {
        // `from` may be a single hash or a list of hashes (one reviewed edit can supersede
        // several historical revisions). Normalize with [].concat and validate every element.
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const fromList = [].concat(r.from);
            assert.ok(fromList.length >= 1, file + ': from must have at least one hash');
            assert.strictEqual(new Set(fromList).size, fromList.length, file + ': from hashes must be unique');
            assert.match(r.to, /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
            for (const from of fromList) {
                assert.match(from, /^[0-9a-f]{64}$/, file + ': every from must be a sha256 hex digest');
                assert.notStrictEqual(from, r.to, file + ': from and to must differ');
            }
        }
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {
    it('every rebaseline `to` hash matches the committed file content (heals TOWARD the repo, never away from it)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex');
            assert.strictEqual(checksum, r.to,
                file + ': rebaseline target is stale - it must equal the current committed file sha256, ' +
                'otherwise the heal path would rewrite the ledger to a hash that still mismatches.');
        }
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {
    Object.entries(SCRUBBED).forEach(function ([file, recorded]) {
        it(file + ': heals from its pre-scrub revision', function () {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ' must have a rebaseline entry - without it `node src/migration/migrate.js` ' +
                'fails closed on any DB that applied the pre-scrub revision, taking every OTHER ' +
                'pending manual migration down with it.');
            assert.ok([].concat(r.from).includes(recorded),
                file + ': recorded revision ' + recorded.slice(0, 12) + ' is not covered.');
        });
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {
    Object.entries(EXECUTABLE_RESIDUE).forEach(function ([file, residue]) {
        it(file + ': executable SQL is unchanged from what the rebaseline was verified against', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const stripped = raw.split('\n').filter(function (l) {
                return !/^\s*--/.test(l) && l.trim() !== '';
            }).join('\n');
            const got = crypto.createHash('sha256').update(stripped).digest('hex');
            assert.strictEqual(got, residue,
                file + ': the executable statements moved. A checksum rebaseline covers ' +
                'comment-only edits ONLY, so this file now needs its own dated migration ' +
                'rather than an entry in MIGRATION_CHECKSUM_REBASELINES.');
        });
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {
    Object.entries(XC805).forEach(function ([file, expected]) {
        it(file + ': heals from both its pre-rename and its license-header revision', function () {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ' must have a rebaseline entry - without it the immutability ' +
                'guard fires on every indexer start and can no longer flag a genuine edit.');
            const fromList = [].concat(r.from);
            expected.forEach(function (hash) {
                assert.ok(fromList.includes(hash),
                    file + ': recorded revision ' + hash.slice(0, 12) + ' is not covered by the ' +
                    'rebaseline, so DBs that applied it keep logging content CHANGED.');
            });
        });
    });
});

// End-to-end over the runner's mismatch branch itself, against a stubbed connection:
// the pinned-predecessor case must re-key the ledger row and stay silent, while any
// other divergence must still be reported. This is what "restart an indexer and see
// zero `content CHANGED` lines" checks, minus the live DB.
    const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const fileChecksums = () => {
        const out = new Map();
        for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
            out.set(f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
        }
        return out;
    };

    // Runs runMigrations against a fake connection seeded with `ledger` (name -> checksum),
    // capturing every UPDATE and every console line. Nothing is applied: the ledger passed
    // in always covers every file on disk, so the runner only walks the compare branch.
    async function runAgainst(ledger) {
        const updates = [];
        const logged  = [];
        const conn = {
            query: async function (sql, params) {
                if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
                if (/RELEASE_LOCK/i.test(sql)) return [{}];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                    return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
                }
                // Bare-ledger harness, live-schema question: see BRIDGE_TABLES_PROBE above.
                if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
                // The ledger's own CREATE TABLE IF NOT EXISTS runs on every call; it is
                // setup, not a write the runner decided to make, so it is not recorded.
                if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
                if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) { updates.push({ sql, params }); return {}; }
                return [];
            },
            release: async function () {},
        };
        const db = {
            dbName: 'test_indexer',
            transactionConnection: null,
            getConnection: async () => conn,
            ensureMigrationsLedger: Database.prototype.ensureMigrationsLedger,
            runMigrationsInner: Database.prototype.runMigrationsInner,
            assertPubkeyColumnIsUncompressedWide: Database.prototype.assertPubkeyColumnIsUncompressedWide,
            assertStakeWeightOrderingCollation: Database.prototype.assertStakeWeightOrderingCollation,
            migrationMode: Database.prototype.migrationMode,
            migrationPreconditionSkip: Database.prototype.migrationPreconditionSkip,
            splitSqlStatements: Database.prototype.splitSqlStatements,
            stripSqlLineComments: Database.prototype.stripSqlLineComments,
            destructiveAutoStatement: Database.prototype.destructiveAutoStatement,
            isIdRepairUpdate: Database.prototype.isIdRepairUpdate,
        };
        const realLog = console.log, realErr = console.error, realWarn = console.warn;
        console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
        try {
            await Database.prototype.runMigrations.call(db, {});
        } finally {
            console.log = realLog; console.error = realErr; console.warn = realWarn;
        }
        return { updates, logged };
    }

describe('runMigrations() checksum heal branch @regression @tier1', function () {
    it('a fully current ledger produces no heal and no divergence log', async function () {
        const { updates, logged } = await runAgainst(fileChecksums());
        assert.deepStrictEqual(updates, [], 'nothing should be written when every checksum matches');
        assert.ok(!logged.some(l => /content CHANGED/.test(l)), 'unexpected divergence: ' + logged.join(' | '));
    });

    it('the pre-rename ledger heals silently instead of logging content CHANGED', async function () {
        // Exactly the prod-fleet shape: migrated before the 2026-07-12 rename, so the two
        // files that carry their own name in a comment recorded the pre-rename hashes.
        const ledger = fileChecksums();
        ledger.set('2026-06-03-unique-full-column-index-addresses.sql',
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e');
        ledger.set('2026-06-09-cross-chain-matches-partial-fill-columns.sql',
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602');

        const { updates, logged } = await runAgainst(ledger);
        assert.ok(!logged.some(l => /content CHANGED/.test(l)),
            'the guard still cries wolf: ' + logged.filter(l => /content CHANGED/.test(l)).join(' | '));

        const healed = new Map(updates
            .filter(u => /SET checksum/i.test(u.sql))
            .map(u => [u.params[1], u.params[0]]));
        assert.strictEqual(healed.size, 2, 'both rows should be re-keyed, got: ' + JSON.stringify([...healed]));
        for (const [file, checksum] of healed) {
            assert.strictEqual(checksum, sha256(fs.readFileSync(path.join(MIG_DIR, file), 'utf8')),
                file + ': healed to something other than the current file checksum');
        }
    });
});

describe('runMigrations() checksum heal branch @regression @tier1', function () {
    it('a never-re-keyed ledger heals name AND checksum in one pass', async function () {
        // The untouched original shape: rows still under the legacy undated names, holding
        // the checksums of the content that was applied. Both heals must run in order (the
        // rename re-key first, then the rebaseline) or the file reads as never-applied and
        // a manual migration silently re-enters the pending list.
        const ledger = fileChecksums();
        const renames = Database.MIGRATION_LEDGER_RENAMES;
        ledger.delete(renames['unique_full_column_index_addresses.sql']);
        ledger.delete(renames['add_cross_chain_matches_partial_fill_columns.sql']);
        ledger.set('unique_full_column_index_addresses.sql',
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e');
        ledger.set('add_cross_chain_matches_partial_fill_columns.sql',
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602');

        const { updates, logged } = await runAgainst(ledger);
        assert.ok(!logged.some(l => /content CHANGED/.test(l)), 'divergence still logged: ' + logged.join(' | '));
        assert.strictEqual(updates.filter(u => /SET name/i.test(u.sql)).length, 2, 'both rows should be re-keyed by name');
        assert.strictEqual(updates.filter(u => /SET checksum/i.test(u.sql)).length, 2, 'both rows should then be rebaselined');
        assert.deepStrictEqual(updates.filter(u => /^INSERT/i.test(u.sql.trim())), [],
            'a re-keyed row must not be re-applied as if it were pending');
    });

    it('an unpinned edit to a rebaselined file still trips the immutability guard', async function () {
        const ledger = fileChecksums();
        ledger.set('2026-06-03-unique-full-column-index-addresses.sql', 'f'.repeat(64));
        const { updates, logged } = await runAgainst(ledger);
        assert.deepStrictEqual(updates.filter(u => /SET checksum/i.test(u.sql)), [],
            'an unrecognized hash must never be healed away');
        assert.ok(logged.some(l => /content CHANGED/.test(l) && /unique-full-column-index-addresses/.test(l)),
            'a genuine migration edit must still be reported');
    });
});
