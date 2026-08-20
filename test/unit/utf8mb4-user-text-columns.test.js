/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * A 4-byte character must survive ingest.
 *
 * The columns below hold free-form wire text. They were declared under the tables'
 * utf8mb3 default (max 3 bytes per character), so no character outside the Basic
 * Multilingual Plane fits: under STRICT_TRANS_TABLES the INSERT fails errno 1366 and the
 * block loop retries that block forever, so one legal broadcast halts every indexer on
 * the chain at the same height. transactions.data is reached first (it stores the whole
 * decoded action string); the per-action projections are the same bytes after the parse.
 *
 * Three arms, because a charset needs BOTH schema paths and the live ingest to agree:
 *   DEFINITION - src/sql/<table>.sql declares utf8mb4 (what a fresh install gets).
 *   LEDGER     - a dated migration MODIFYs it (what an aged DB converges to).
 *   INGEST     - the real create* writers, driven through a connection stub that
 *                enforces the server's utf8mb3 rejection against the DECLARED charset
 *                of each column it is handed. The stub reads the definition files, so
 *                reverting a schema edit turns the ingest arm red rather than leaving
 *                the guard passing on a schema-only assertion.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

// The ruled scope: columns that ingest free-form wire text. Deliberately absent, each
// for a reason recorded in 2026-08-19-utf8mb4-user-text-columns.sql: contracts.code and
// contract_state.* (consensus preimage / height-gated collation flag-day),
// polls.callback_params (its ADD COLUMN migration is checksum-immutable at plain
// MEDIUMTEXT), and the grammar-constrained numeric / hex / enum fields.
const USER_TEXT_COLUMNS = {
    transactions: ['data'],
    index_memos:  ['memo'],
    broadcasts:   ['message'],
    files:        ['name', 'title'],
    messages:     ['encryption_key', 'encrypted_message', 'plaintext_message'],
    tokens:       ['description'],
    issues:       ['description'],
    polls:        ['options', 'question'],
    bet_feeds:    ['label', 'outcomes', 'details'],
};

// U+1F680: four UTF-8 bytes, so utf8mb3 cannot hold it at any column width.
const EMOJI = '\u{1F680}';

const stripComments = Database.prototype.stripSqlLineComments.bind({});

// name -> full comment-stripped column definition line, from the real definition file.
function definitionColumns(table) {
    const raw    = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    assert.ok(parsed, 'could not parse src/sql/' + table + '.sql');
    const out = {};
    for (const c of parsed) out[c.name] = c.definition;
    return out;
}

const declaresUtf8mb4 = (spec) => /CHARACTER\s+SET\s+utf8mb4\b/i.test(String(spec || ''));

// Cache: the writers below hit the same handful of tables on every call.
const DEFS = {};
const defsFor = (table) => (DEFS[table] || (DEFS[table] = definitionColumns(table)));

const hasAstralChar = (v) => typeof v === 'string' && /[\u{10000}-\u{10FFFF}]/u.test(v);

/**
 * A doQuery stub that behaves like a STRICT_TRANS_TABLES server: it maps an INSERT's
 * positional parameters onto the named columns, looks each column's DECLARED charset up
 * in src/sql/<table>.sql, and rejects a 4-byte character bound to a utf8mb3 column the
 * way MariaDB does. Every non-INSERT (the exists probes, the id refetches) returns [].
 */
function makeStrictServer() {
    return sinon.stub().callsFake(async function (sql, args) {
        const m = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(String(sql));
        if (!m) return [];
        const table   = m[1];
        const columns = m[2].split(',').map(s => s.trim().replace(/`/g, ''));
        const defs    = defsFor(table);
        (args || []).forEach(function (value, i) {
            const column = columns[i];
            if (!column || !hasAstralChar(value)) return;
            assert.ok(Object.prototype.hasOwnProperty.call(defs, column),
                'stub cannot check ' + table + '.' + column + ': not declared in src/sql/' + table + '.sql');
            if (!declaresUtf8mb4(defs[column]))
                throw Object.assign(
                    new Error("Incorrect string value for column '" + column + "' at row 1"),
                    { errno: 1366, code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' });
        });
        return [];
    });
}

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('user-text columns hold a 4-byte character @regression', function () {

    afterEach(() => sinon.restore());

    it('sanity: the fixture character really is 4 bytes (utf8mb3 cannot hold it)', function () {
        assert.strictEqual(Buffer.byteLength(EMOJI, 'utf8'), 4);
        assert.ok(hasAstralChar(EMOJI));
        assert.ok(!hasAstralChar('plain ascii memo'));
    });

    // DEFINITION path: what createTable gives a fresh install.
    for (const [table, columns] of Object.entries(USER_TEXT_COLUMNS)) {
        for (const column of columns) {
            it('src/sql/' + table + '.sql declares ' + column + ' CHARACTER SET utf8mb4', function () {
                const spec = definitionColumns(table)[column];
                assert.ok(spec, table + '.' + column + ' is no longer declared');
                assert.ok(declaresUtf8mb4(spec),
                    table + '.' + column + ' would inherit the table\'s utf8mb3 default, so a 4-byte ' +
                    'character fails errno 1366 and halts the block loop on a legal broadcast: ' + spec);
            });
        }
    }

    // LEDGER path: what an aged DB converges to by replaying migrations. The MODIFY's
    // spec is held byte-equal to the definition by sql-schema-column-parity.test.js;
    // this arm only proves the MODIFY exists at all, which is what that gate needs to
    // have something to compare.
    it('a dated migration MODIFYs every one of them to utf8mb4', function () {
        const seen = new Set();
        for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
            const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
            for (const stmt of raw.split(';')) {
                const t = /ALTER\s+TABLE\s+`?(\w+)`?/i.exec(stmt);
                if (!t) continue;
                for (const m of stmt.matchAll(/\bMODIFY\s+(?:COLUMN\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*MODIFY\s|,\s*ADD\s|,\s*DROP\s|$)/gi)) {
                    if (declaresUtf8mb4(m[2])) seen.add(t[1] + '.' + m[1]);
                }
            }
        }
        const missing = [];
        for (const [table, columns] of Object.entries(USER_TEXT_COLUMNS))
            for (const column of columns)
                if (!seen.has(table + '.' + column)) missing.push(table + '.' + column);

        assert.deepStrictEqual(missing, [],
            'These columns are utf8mb4 in the definition but no dated migration widens them, so a ' +
            'long-lived DB keeps utf8mb3 forever (alterTableForDrift adds missing columns, it never ' +
            'retypes an existing one) and stays halted on the same broadcast:\n  ' + missing.join('\n  '));
    });

    // INGEST path: the real writers, against the strict-server stub.
    describe('the ingest writers survive a 4-byte character', function () {

        it('createTxIndex: the whole decoded action string (transactions.data)', async function () {
            const db = makeDb();
            const doQuery = makeStrictServer();
            sinon.stub(db, 'doQuery').callsFake(doQuery);
            sinon.stub(db, 'getTxIndex').resolves(null);
            sinon.stub(db, 'getNextTxIndex').resolves(42);
            sinon.stub(db, 'createAddress').resolves(7);
            sinon.stub(db, 'createTransaction').resolves(9);

            await db.createTxIndex({ TX_HASH: 'ab'.repeat(32), BLOCK_INDEX: 6001, SOURCE: 'x',
                                     FEE: 1000, TX_DATA: 'BROADCAST|0|probe ' + EMOJI });

            const insert = doQuery.getCalls().find(c => /INSERT INTO transactions/i.test(c.args[0]));
            assert.ok(insert, 'expected an INSERT INTO transactions');
            assert.ok(insert.args[1].some(v => hasAstralChar(v)), 'the 4-byte character never reached the column');
        });

        it('createMemo: the MEMO nearly every action carries (index_memos.memo)', async function () {
            const db = makeDb();
            const doQuery = makeStrictServer();
            sinon.stub(db, 'doQuery').callsFake(doQuery);
            const getMemoId = sinon.stub(db, 'getMemoId');
            getMemoId.onFirstCall().resolves(null);
            getMemoId.resolves(3);

            const id = await db.createMemo('gm ' + EMOJI);
            assert.strictEqual(id, 3);
            const insert = doQuery.getCalls().find(c => /INSERT IGNORE INTO index_memos/i.test(c.args[0]));
            assert.ok(insert, 'expected an INSERT IGNORE INTO index_memos');
            assert.ok(hasAstralChar(insert.args[1][0]));
        });

        it('createBroadcast: BROADCAST text (broadcasts.message)', async function () {
            const db = makeDb();
            const doQuery = makeStrictServer();
            sinon.stub(db, 'doQuery').callsFake(doQuery);
            sinon.stub(db, 'createMemo').resolves(null);
            sinon.stub(db, 'createStatus').resolves(1);

            await db.createBroadcast({ ACTION_INDEX: 1, STATUS: 'valid', MESSAGE: 'to the moon ' + EMOJI });

            const insert = doQuery.getCalls().find(c => /INSERT INTO broadcasts/i.test(c.args[0]));
            assert.ok(insert, 'expected an INSERT INTO broadcasts');
            assert.ok(insert.args[1].some(v => hasAstralChar(v)));
        });

        it('createFile: FILE name and title (files.name, files.title)', async function () {
            const db = makeDb();
            const doQuery = makeStrictServer();
            sinon.stub(db, 'doQuery').callsFake(doQuery);
            sinon.stub(db, 'createMimeType').resolves(2);
            sinon.stub(db, 'createMemo').resolves(null);
            sinon.stub(db, 'createStatus').resolves(1);

            await db.createFile({ ACTION_INDEX: 2, STATUS: 'valid', TYPE: 'image/png',
                                  NAME: EMOJI + '.png', TITLE: 'launch ' + EMOJI });

            const insert = doQuery.getCalls().find(c => /INSERT INTO files/i.test(c.args[0]));
            assert.ok(insert, 'expected an INSERT INTO files');
            assert.strictEqual(insert.args[1].filter(v => hasAstralChar(v)).length, 2);
        });

        it('createMessage: MESSAGE bodies and key (messages.*)', async function () {
            const db = makeDb();
            const doQuery = makeStrictServer();
            sinon.stub(db, 'doQuery').callsFake(doQuery);
            sinon.stub(db, 'createAddress').resolves(5);
            sinon.stub(db, 'createStatus').resolves(1);

            await db.createMessage({ ACTION_INDEX: 3, STATUS: 'valid', COIN: 'BTC', DESTINATION: 'x',
                                     ENCRYPTION_METHOD: 1, ENCRYPTION_KEY: 'k' + EMOJI,
                                     ENCRYPTED_MESSAGE: 'c' + EMOJI, PLAINTEXT_MESSAGE: 'hi ' + EMOJI });

            const insert = doQuery.getCalls().find(c => /INSERT INTO messages/i.test(c.args[0]));
            assert.ok(insert, 'expected an INSERT INTO messages');
            assert.strictEqual(insert.args[1].filter(v => hasAstralChar(v)).length, 3);
        });

        // The arms above are only worth their green if the stub can actually fail. Point
        // it at a column that legitimately stays utf8mb3 (index_statuses.status is an
        // internal enum-like label, never wire text) and it must reject.
        it('sanity: the strict-server stub rejects a 4-byte character on a utf8mb3 column', async function () {
            const doQuery = makeStrictServer();
            await assert.rejects(
                () => doQuery('INSERT INTO index_statuses (status) values (?)', ['ok ' + EMOJI]),
                (err) => err.errno === 1366);
            // ASCII on the same column stays accepted, so the stub is not rejecting everything.
            await doQuery('INSERT INTO index_statuses (status) values (?)', ['valid']);
        });
    });
});
