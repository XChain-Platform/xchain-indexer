'use strict';

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
 * index_memos interns memo text by equality: createMemo looks the memo up
 * with WHERE memo=?, and on a miss does INSERT IGNORE plus a refetch against
 * the UNIQUE index on memo. The column collation therefore IS the identity of
 * a memo. Under utf8mb4_general_ci 'memo case' equals 'Memo Case' and every
 * 4-byte character weighs the same, so a SEND whose wire carried one of those
 * was linked to another memo's row and its own text was lost. utf8mb4_bin is
 * PAD SPACE and still folds 'memo ' onto 'memo'. Only utf8mb4_nopad_bin keeps
 * the stored memo equal to the memo on the wire.
 *
 * The unit half drives the real createMemo against a server stub whose
 * equality follows the collation src/sql/index_memos.sql DECLARES, so it fails
 * on the folding definition and passes on the binary one. The ledger half
 * proves an aged database converges to the same collation. The DB half runs
 * the same calls against a real MariaDB when TEST_DB_PASS is set.
 ********************************************************************/

const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const sinon   = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

const SQL_DIR  = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const MIG_DIR  = path.join(SQL_DIR, 'migrations');
const DEF_FILE = path.join(SQL_DIR, 'index_memos.sql');

const stripComments = Database.prototype.stripSqlLineComments.bind({});

// Memo pairs that a folding or PAD SPACE collation treats as one memo.
const GRIN       = '\u{1F600} grin';
const SUNGLASSES = '\u{1F60E} grin';
const PAIRS = [
    ['letter case',               'Memo Case',  'memo case'],
    ['two different 4-byte chars', GRIN,         SUNGLASSES],
    ['a trailing space',          'memo pad',   'memo pad '],
];

function declaredMemoSpec() {
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments },
        fs.readFileSync(DEF_FILE, 'utf8'));
    const col = (parsed || []).find(c => c.name === 'memo');
    assert.ok(col, 'src/sql/index_memos.sql no longer declares memo');
    return col.definition;
}

function collationOf(spec) {
    const m = /\bCOLLATE\s+`?(\w+)`?/i.exec(String(spec));
    return m ? m[1].toLowerCase() : null;
}

// The equality key MariaDB uses for a value under each collation the column has had or
// could plausibly be given. general_ci: case-insensitive, every supplementary-plane
// character weighs as U+FFFD, PAD SPACE. _bin: byte equality, PAD SPACE. nopad_bin:
// byte equality. An unknown collation fails loudly rather than guessing.
function equalityKey(collation, value) {
    const s = String(value);
    switch (collation) {
    case 'utf8mb4_general_ci':
        return s.replace(/[\u{10000}-\u{10FFFF}]/gu, '�').toUpperCase().replace(/ +$/, '');
    case 'utf8mb4_bin':
        return s.replace(/ +$/, '');
    case 'utf8mb4_nopad_bin':
        return s;
    default:
        throw new Error('equalityKey: no model for collation ' + collation);
    }
}

// A doQuery stub holding index_memos in memory, with SELECT ... WHERE memo=? and the
// UNIQUE-guarded INSERT IGNORE both comparing through the declared collation.
function makeMemoServer(collation) {
    const rows = [];
    let nextId = 1;
    const find = (memo) => rows.find(r => equalityKey(collation, r.memo) === equalityKey(collation, memo));
    const stub = sinon.stub().callsFake(async function (sql, args) {
        const text = String(sql);
        if (/^\s*SELECT\s+id\s+FROM\s+index_memos\s+WHERE\s+memo\s*=\s*\?/i.test(text)) {
            const hit = find(args[0]);
            return hit ? [{ id: hit.id }] : [];
        }
        if (/^\s*INSERT\s+IGNORE\s+INTO\s+index_memos\s*\(\s*memo\s*\)/i.test(text)) {
            if (!find(args[0])) rows.push({ id: nextId++, memo: args[0] });
            return { affectedRows: 1 };
        }
        throw new Error('memo server stub: unexpected query ' + text);
    });
    return { stub, rows };
}

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

describe('index_memos keeps every distinct memo distinct @regression', function () {
    afterEach(() => sinon.restore());

    it('src/sql/index_memos.sql declares memo utf8mb4 with the no-pad binary collation', function () {
        const spec = declaredMemoSpec();
        assert.match(spec, /CHARACTER\s+SET\s+utf8mb4\b/i, spec);
        assert.strictEqual(collationOf(spec), 'utf8mb4_nopad_bin',
            'index_memos.memo must compare memo text byte for byte, trailing spaces included: ' + spec);
    });

    for (const [label, first, second] of PAIRS) {
        it('createMemo gives memos differing by ' + label + ' their own rows and text', async function () {
            const db = makeDb();
            const server = makeMemoServer(collationOf(declaredMemoSpec()));
            sinon.stub(db, 'doQuery').callsFake(server.stub);

            const a = await db.createMemo(first);
            const b = await db.createMemo(second);

            assert.notStrictEqual(a, b, JSON.stringify(second) + ' was linked to the row of ' + JSON.stringify(first));
            const stored = new Map(server.rows.map(r => [r.id, r.memo]));
            assert.strictEqual(stored.get(a), first);
            assert.strictEqual(stored.get(b), second);
        });
    }

    it('createMemo of the same memo twice returns the same id (interning still dedupes)', async function () {
        const db = makeDb();
        const server = makeMemoServer(collationOf(declaredMemoSpec()));
        sinon.stub(db, 'doQuery').callsFake(server.stub);

        const a = await db.createMemo(GRIN);
        const b = await db.createMemo(GRIN);
        assert.strictEqual(a, b);
        assert.strictEqual(server.rows.length, 1);
    });

    it('the newest dated migration touching index_memos.memo lands on the declared spec', function () {
        let last = null;
        for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
            const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
            for (const stmt of raw.split(';')) {
                if (!/ALTER\s+TABLE\s+`?index_memos`?/i.test(stmt)) continue;
                const m = /\bMODIFY\s+(?:COLUMN\s+)?`?memo`?\s+([\s\S]+)$/i.exec(stmt.trim());
                if (m) last = { file, spec: m[1].trim() };
            }
        }
        assert.ok(last, 'no dated migration MODIFYs index_memos.memo');
        assert.strictEqual(collationOf(last.spec), 'utf8mb4_nopad_bin',
            last.file + ' leaves an aged database on a folding collation: ' + last.spec);
        const norm = s => String(s).replace(/\s+/g, ' ').trim().toUpperCase();
        assert.strictEqual(norm(last.spec), norm(declaredMemoSpec().replace(/^\s*`?memo`?\s+/i, '')),
            last.file + ' does not restate the definition exactly');
        assert.match(fs.readFileSync(path.join(MIG_DIR, last.file), 'utf8'), /--\s*xchain:migration\s+mode=manual\b/,
            'a MODIFY carrying NOT NULL is refused by the auto-apply classifier, so it must be mode=manual');
    });
});

describe('index_memos keeps every distinct memo distinct against MariaDB @regression', function () {
    const ctx = {};

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        this.timeout(30000);
        const mariadb = require('mariadb');
        const base = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';
        ctx.dbName = (base + '_memo_collation_' + crypto.createHash('sha1').update(__filename).digest('hex').slice(0, 6)).slice(0, 64);
        ctx.conn = await mariadb.createConnection({
            host: process.env.TEST_DB_HOST || '127.0.0.1',
            port: parseInt(process.env.TEST_DB_PORT || '3306', 10),
            user: process.env.TEST_DB_USER || 'root',
            password: process.env.TEST_DB_PASS,
            multipleStatements: true,
        });
        await ctx.conn.query('DROP DATABASE IF EXISTS `' + ctx.dbName + '`');
        await ctx.conn.query('CREATE DATABASE `' + ctx.dbName + '` CHARACTER SET utf8mb4');
        await ctx.conn.query('USE `' + ctx.dbName + '`');
        await ctx.conn.query(fs.readFileSync(DEF_FILE, 'utf8'));
    });

    after(async function () {
        if (!ctx.conn) return;
        try { await ctx.conn.query('DROP DATABASE IF EXISTS `' + ctx.dbName + '`'); }
        finally { await ctx.conn.end(); }
    });

    afterEach(() => sinon.restore());

    it('the real createMemo stores each memo of every folding pair under its own id and exact text', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake((sql, args) => ctx.conn.query(sql, args));

        for (const [label, first, second] of PAIRS) {
            const a = await db.createMemo(first);
            const b = await db.createMemo(second);
            assert.notStrictEqual(a, b, label + ': the second memo reused the first row');
            assert.strictEqual(await db.createMemo(first), a, label + ': re-interning the first memo moved its id');
            for (const [id, want] of [[a, first], [b, second]]) {
                const rows = await ctx.conn.query('SELECT HEX(memo) AS h FROM index_memos WHERE id = ?', [id]);
                assert.strictEqual(rows[0].h, Buffer.from(want, 'utf8').toString('hex').toUpperCase(), label);
            }
        }
    });
});
