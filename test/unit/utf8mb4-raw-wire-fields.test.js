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
 * A 4-byte character must survive ingest into the GRAMMAR-CONSTRAINED columns too.
 *
 * Sibling of utf8mb4-user-text-columns.test.js, which covers the free-form text columns
 * the 2026-08-19 pass widened. This one covers the two groups that pass deliberately left
 * behind and that the 2026-09-02 pair widens: contracts.code (plus its chunked twin
 * deploy_chunks.code_part) and the raw wire fields an action persists even when it fails
 * validation. src/utf8mb4Columns.js is the single list all three paths read.
 *
 * Four arms, because a charset needs both schema paths, the right apply mode, and the live
 * ingest to agree:
 *   DEFINITION - src/sql/<table>.sql declares utf8mb4 (what a fresh install gets).
 *   LEDGER     - a dated migration MODIFYs it, in a file whose mode=... tag matches the
 *                entry's mode (what an aged DB converges to, attended or not).
 *   MODE       - the auto file really is auto-eligible and the manual file really is not,
 *                so the split is a property of the SQL rather than of the tag.
 *   INGEST     - the real create* writers, driven through a connection stub that enforces
 *                the server's utf8mb3 rejection against the DECLARED charset of each
 *                column it is handed. The stub reads the definition files, so reverting a
 *                schema edit turns the ingest arm red rather than leaving the guard
 *                passing on a schema-only assertion.
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
const widenSet          = require('../../src/utf8mb4Columns');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

// U+1F680: four UTF-8 bytes, so utf8mb3 cannot hold it at any column width.
const EMOJI = '\u{1F680}';

const stripComments  = Database.prototype.stripSqlLineComments.bind({});
const declaresUtf8mb4 = (spec) => /CHARACTER\s+SET\s+utf8mb4\b/i.test(String(spec || ''));
const hasAstralChar   = (v) => typeof v === 'string' && /[\u{10000}-\u{10FFFF}]/u.test(v);

// Same normalization the schema-parity suite compares on: uppercase, single spaces, no
// backticks or trailing comma. Two specs that differ only in wrapping compare equal.
const normalizeSpec = (spec) => String(spec || '')
    .replace(/`/g, '').replace(/\s+/g, ' ').replace(/\s*,\s*$/, '').trim().toUpperCase();

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

// Cache: the writers below hit the same handful of tables on every call.
const DEFS = {};
const defsFor = (table) => (DEFS[table] || (DEFS[table] = definitionColumns(table)));

/**
 * Bind an INSERT's parameters to the columns they land in: { table, bound: [[col, value]] }.
 * Null for anything that is not an INSERT (the exists probes, the id refetches).
 *
 * Positional index is NOT the same as parameter index. createAttestationRequest writes
 * `(action_index, version, ...) VALUES (?, 0, ?, ...)` - a literal in the VALUES tuple - so
 * a naive columns[i] mapping walks off by one from there on and blames the wrong column.
 * Walk the VALUES tuple and consume an argument only where a `?` actually sits.
 */
function insertBindings(sql, args) {
    const text = String(sql);
    const head = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(text);
    if (!head) return null;
    const columns = head[2].split(',').map(s => s.trim().replace(/`/g, ''));
    const slots   = head[3].split(',').map(s => s.trim());
    const bound   = [];
    let next = 0;
    slots.forEach(function (slot, i) {
        if (slot !== '?') return;                 // a literal in the VALUES tuple consumes no argument
        const value = (args || [])[next++];
        if (columns[i]) bound.push([columns[i], value]);
    });
    return { table: head[1], bound };
}

/**
 * A doQuery stub that behaves like a STRICT_TRANS_TABLES server: it maps an INSERT's
 * parameters onto the named columns, looks each column's DECLARED charset up in
 * src/sql/<table>.sql, and rejects a 4-byte character bound to a utf8mb3 column the way
 * MariaDB does. Every non-INSERT (the exists probes, the id refetches) returns [].
 */
function makeStrictServer() {
    return sinon.stub().callsFake(async function (sql, args) {
        const insert = insertBindings(sql, args);
        if (!insert) return [];
        const defs = defsFor(insert.table);
        for (const [column, value] of insert.bound) {
            if (!hasAstralChar(value)) continue;
            assert.ok(Object.prototype.hasOwnProperty.call(defs, column),
                'stub cannot check ' + insert.table + '.' + column + ': not declared in src/sql/' + insert.table + '.sql');
            if (!declaresUtf8mb4(defs[column]))
                throw Object.assign(
                    new Error("Incorrect string value for column '" + column + "' at row 1"),
                    { errno: 1366, code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' });
        }
        return [];
    });
}

// A Database wired to the strict server, with the id-minting helpers stubbed out (they
// each run their own INSERT into an index_ table, which is not what these arms measure).
function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const doQuery = makeStrictServer();
    sinon.stub(db, 'doQuery').callsFake(doQuery);
    for (const method of ['createMemo', 'createStatus', 'createTicker', 'createAddress',
                          'getAddressId', 'createMimeType', 'createPubkey'])
        if (typeof db[method] === 'function') sinon.stub(db, method).resolves(1);
    return { db, doQuery };
}

// The columns of `table` that an INSERT carried a 4-byte character into.
function astralColumns(doQuery, table) {
    const hit = new Set();
    for (const call of doQuery.getCalls()) {
        const insert = insertBindings(call.args[0], call.args[1]);
        if (!insert || insert.table.toLowerCase() !== table.toLowerCase()) continue;
        for (const [column, value] of insert.bound) if (hasAstralChar(value)) hit.add(column);
    }
    return hit;
}

// Every table.column a dated migration MODIFYs to utf8mb4, with the file it came from.
function migrationWidens() {
    const seen = new Map();
    for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
        const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        const mode = Database.prototype._migrationMode.call({}, fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        for (const stmt of raw.split(';')) {
            const t = /ALTER\s+TABLE\s+`?(\w+)`?/i.exec(stmt);
            if (!t) continue;
            for (const m of stmt.matchAll(/\bMODIFY\s+(?:COLUMN\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*MODIFY\s|,\s*ADD\s|,\s*DROP\s|$)/gi)) {
                if (declaresUtf8mb4(m[2]))
                    seen.set(t[1] + '.' + m[1], { file, mode, spec: normalizeSpec(m[2]) });
            }
        }
    }
    return seen;
}

describe('the grammar-constrained raw wire columns hold a 4-byte character @regression', function () {

    afterEach(() => sinon.restore());

    it('sanity: the widen set is populated and the fixture character really is 4 bytes', function () {
        assert.ok(widenSet.UTF8MB4_RAW_FIELD_COLUMNS.length >= 60,
            'the widen set shrank; a removed entry silently re-opens that column as a halt vector');
        assert.strictEqual(Buffer.byteLength(EMOJI, 'utf8'), 4);
        assert.ok(hasAstralChar(EMOJI));
        assert.ok(!hasAstralChar('plain ascii value'));
        // contracts.code is the named half of the ledger item; keep it pinned by name so a
        // list edit cannot drop the one column the operator ruling called out.
        const named = widenSet.UTF8MB4_RAW_FIELD_COLUMNS
            .filter(e => e.table === 'contracts' && e.column === 'code');
        assert.strictEqual(named.length, 1, 'contracts.code must stay in the widen set');
    });

    // DEFINITION path: what createTable gives a fresh install.
    it('every entry is declared CHARACTER SET utf8mb4 in src/sql/<table>.sql, with the module\'s exact spec', function () {
        const wrong = [];
        for (const entry of widenSet.UTF8MB4_RAW_FIELD_COLUMNS) {
            const declared = definitionColumns(entry.table)[entry.column];
            if (!declared) { wrong.push(entry.table + '.' + entry.column + ' is no longer declared'); continue; }
            // The definition line starts with the column name; compare the spec after it.
            const spec = normalizeSpec(String(declared)
                .replace(new RegExp('^\\s*`?' + entry.column + '`?\\s*', 'i'), ''));
            const want = normalizeSpec(widenSet.columnSpec(entry));
            if (spec !== want)
                wrong.push('  ' + entry.table + '.' + entry.column + '\n    module:     ' + want +
                           '\n    definition: ' + spec);
        }
        assert.deepStrictEqual(wrong, [],
            'These columns disagree with src/utf8mb4Columns.js, so the module no longer describes what a ' +
            'fresh install gets and the xchain-sync replica widen would issue the wrong MODIFY:\n' + wrong.join('\n'));
    });

    // LEDGER path: what an aged DB converges to by replaying migrations, and under which
    // apply mode. A mode mismatch is the difference between a wedge that closes itself at
    // the next restart and one that waits on an operator.
    it('a dated migration MODIFYs every entry to utf8mb4, in a file tagged with the entry\'s mode', function () {
        const widens  = migrationWidens();
        const missing = [];
        const misfiled = [];
        for (const entry of widenSet.UTF8MB4_RAW_FIELD_COLUMNS) {
            const found = widens.get(entry.table + '.' + entry.column);
            if (!found) { missing.push('  ' + entry.table + '.' + entry.column); continue; }
            if (found.mode !== entry.mode)
                misfiled.push('  ' + entry.table + '.' + entry.column + ': module says mode=' + entry.mode +
                              ', ' + found.file + ' is mode=' + found.mode);
            if (found.spec !== normalizeSpec(widenSet.columnSpec(entry)))
                misfiled.push('  ' + entry.table + '.' + entry.column + ': ' + found.file + ' MODIFYs it to ' +
                              found.spec + ', module says ' + normalizeSpec(widenSet.columnSpec(entry)));
        }
        assert.deepStrictEqual(missing, [],
            'These columns are utf8mb4 in the definition but no dated migration widens them, so a long-lived ' +
            'DB keeps utf8mb3 forever (alterTableForDrift adds missing columns, it never retypes an existing ' +
            'one) and stays halted on the same transaction:\n' + missing.join('\n'));
        assert.deepStrictEqual(misfiled, [], 'Migration / module disagreement:\n' + misfiled.join('\n'));
    });

    // MODE: the split between the two files is a property of the SQL, not of the tag. The
    // auto half must survive the destructive-DDL classifier that runs before an unattended
    // apply; the manual half must NOT, or it was needlessly withheld from startup.
    it('the auto half is auto-eligible and the NOT NULL half genuinely is not', function () {
        const db = Object.create(Database.prototype);
        const statementsOf = (file) => Database.prototype.splitSqlStatements.call(
            { stripSqlLineComments: Database.prototype.stripSqlLineComments },
            fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));

        assert.strictEqual(
            Database.prototype._destructiveAutoStatement.call(db, statementsOf('2026-09-02-utf8mb4-raw-wire-fields.sql')),
            null,
            'the mode=auto raw-wire-field widen contains DDL the classifier refuses to run unattended; ' +
            'runMigrations would throw at startup on every indexer');

        assert.ok(
            Database.prototype._destructiveAutoStatement.call(db, statementsOf('2026-09-02-utf8mb4-raw-wire-fields-not-null.sql')),
            'the NOT NULL half is auto-eligible after all, so splitting it into a mode=manual file leaves ' +
            'contracts.code wedged until an operator runs it for no reason - fold it into the auto file');
    });

    // INGEST path: the real writers, against the strict-server stub. Each case is a column
    // the probe showed carries a raw 4-byte character all the way to the INSERT.
    describe('the ingest writers survive a 4-byte character', function () {

        it('createContract: contract source on an INVALID deploy (contracts.code)', async function () {
            const { db, doQuery } = makeDb();
            await db.createContract({ ACTION: 'DEPLOY', ACTION_INDEX: 1, SOURCE: 's', BLOCK_INDEX: 5,
                                      CODE: 'function f(){ return "' + EMOJI + '"; }',
                                      CODE_HASH: 'ab'.repeat(32), STATUS: 'invalid: CODE (lint)' });
            assert.ok(astralColumns(doQuery, 'contracts').has('code'),
                'the 4-byte character never reached contracts.code');
        });

        it('recordDeployChunk: a chunk of that source (deploy_chunks.code_part)', async function () {
            const { db, doQuery } = makeDb();
            await db.recordDeployChunk({ ACTION: 'DEPLOY', ACTION_INDEX: 2, SOURCE: 's', BLOCK_INDEX: 5,
                                         CODE_HASH: 'ab'.repeat(32), CHUNK_INDEX: 0, TOTAL_CHUNKS: 1,
                                         CODE_PART: 'part ' + EMOJI, STATUS: 'valid' });
            assert.ok(astralColumns(doQuery, 'deploy_chunks').has('code_part'),
                'the 4-byte character never reached deploy_chunks.code_part');
        });

        it('createMessage: the destination COIN tag (messages.coin)', async function () {
            const { db, doQuery } = makeDb();
            await db.createMessage({ ACTION: 'MESSAGE', ACTION_INDEX: 3, STATUS: 'invalid: COIN', COIN: EMOJI,
                                     DESTINATION: 'd', ENCRYPTION_METHOD: 1, ENCRYPTION_KEY: 'k',
                                     ENCRYPTED_MESSAGE: 'c', PLAINTEXT_MESSAGE: 'p' });
            assert.ok(astralColumns(doQuery, 'messages').has('coin'),
                'the 4-byte character never reached messages.coin');
        });

        it('createContractExecution: EXECUTE method, params and error text (contract_executions.*)', async function () {
            const { db, doQuery } = makeDb();
            await db.createContractExecution({ ACTION: 'EXECUTE', ACTION_INDEX: 4, CONTRACT_INDEX: 1, CALLER: 'c',
                                               METHOD_NAME: 'm' + EMOJI, INPUT_PARAMS: '["' + EMOJI + '"]',
                                               GAS_USED: 1, EMITTED_COUNT: 0, BLOCK_INDEX: 5,
                                               ERROR_MESSAGE: 'boom ' + EMOJI, STATUS: 'invalid: METHOD' });
            const hit = astralColumns(doQuery, 'contract_executions');
            assert.deepStrictEqual([...hit].sort(), ['error_message', 'input_params', 'method_name']);
        });

        it('createPoll: the VOTE v0 threshold fractions (polls.*)', async function () {
            const { db, doQuery } = makeDb();
            await db.createPoll({ ACTION: 'VOTE', ACTION_INDEX: 5, BLOCK_INDEX: 5, STATUS: 'invalid: QUORUM',
                                  TICK: 'T', OPTIONS: '["a"]', QUESTION: 'q', QUORUM: EMOJI,
                                  MIN_VOTE_BALANCE: EMOJI, DECIDE_THRESHOLD: EMOJI });
            const hit = astralColumns(doQuery, 'polls');
            assert.deepStrictEqual([...hit].sort(), ['decide_threshold', 'min_vote_balance', 'quorum']);
        });

        it('createBallot: the per-option share and the voter note (votes.share, votes.memo)', async function () {
            const { db, doQuery } = makeDb();
            await db.createBallot({ ACTION: 'VOTE', ACTION_INDEX: 6, BLOCK_INDEX: 5, POLL_REF: 5, SOURCE: 'v',
                                    MEMO: 'note ' + EMOJI, STATUS: 'invalid: SHARE' },
                                  [{ choice: 0, share: EMOJI }]);
            const hit = astralColumns(doQuery, 'votes');
            assert.deepStrictEqual([...hit].sort(), ['memo', 'share']);
        });

        it('createGatedFile: the gate ticker and its threshold (gated_files.*)', async function () {
            const { db, doQuery } = makeDb();
            await db.createGatedFile({ ACTION: 'FILE', ACTION_INDEX: 7, STATUS: 'invalid', SOURCE: 's',
                                       GATE_TICKER: EMOJI, ENCRYPTION_METHOD: 1, KEY_HASH: 'ab'.repeat(32),
                                       GATE_MIN_AMOUNT: EMOJI });
            const hit = astralColumns(doQuery, 'gated_files');
            assert.deepStrictEqual([...hit].sort(), ['gate_min_amount', 'gate_ticker']);
        });

        it('createCrossChainCallRequest: XCALL method and callback params (xcalls.*)', async function () {
            const { db, doQuery } = makeDb();
            await db.createCrossChainCallRequest({ ACTION: 'XCALL', ACTION_INDEX: 8, BLOCK_INDEX: 5, SOURCE: 's',
                                                   STATUS: 'invalid', TARGET_CHAIN: 'LTC', CALL_ID: 'c1',
                                                   METHOD: 'm' + EMOJI, CALLBACK_METHOD: 'cb' + EMOJI,
                                                   CALLBACK_PARAMS: '["' + EMOJI + '"]',
                                                   REQUEST_STATUS: 'pending' });
            const hit = astralColumns(doQuery, 'xcalls');
            assert.ok(hit.has('method') && hit.has('callback_method'),
                'the 4-byte character never reached xcalls.method / callback_method');
        });

        it('createAttestationRequest: the ATTEST payload and callback (attests.*)', async function () {
            const { db, doQuery } = makeDb();
            await db.createAttestationRequest({ ACTION: 'ATTEST', ACTION_INDEX: 9, BLOCK_INDEX: 5, SOURCE: 's',
                                                STATUS: 'invalid', VERSION: 0, REQUEST_ID: 'ab'.repeat(32),
                                                REQUEST_STATUS: 'rejected', PROVIDER_ID: 'p' + EMOJI,
                                                REQUEST_PAYLOAD: 'http://x/' + EMOJI, CALLBACK_METHOD: 'cb' + EMOJI,
                                                CALLBACK_PARAMS: '["' + EMOJI + '"]' });
            const hit = astralColumns(doQuery, 'attests');
            assert.deepStrictEqual([...hit].sort(),
                ['callback_method', 'callback_params_json', 'payload', 'provider_id']);
        });

        // The arms above are only worth their green if the stub can actually fail. Point it
        // at a column that legitimately stays utf8mb3 (index_statuses.status is written by
        // the indexer itself, never from the wire) and it must reject.
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
