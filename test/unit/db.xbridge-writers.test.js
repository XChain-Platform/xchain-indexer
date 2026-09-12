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
 * test/unit/db.xbridge-writers.test.js
 *
 * The two database writers the XBRIDGE handler calls (lane L3b):
 *   createXbridge(data)            - the `xbridges` action row, one per XBRIDGE action
 *   setTokenBridged(tick, block)   - the origin row's sticky `tokens.bridged` bit
 *
 * WHY THE ROW MATTERS. The hub's CrossChainBridgeEngine polls this chain for confirmed
 * locks and burns to sign into a bridge_transfers row. A lock debits the source here
 * whether or not the row is written, so a writer that records nothing produces a debit
 * the federation never learns about and a user's units sit in escrow forever. That is
 * the failure these cases exist to catch, which is why every one of them asserts the
 * RESULTING ROW rather than the SQL text: a SQL-text assertion passes for any statement
 * that merely mentions the right column.
 *
 * Technique, from db.createDestroy-multileg.test.js: drive the REAL methods against an
 * in-memory table simulator behind doQuery. The last describe goes one step further and
 * runs the REAL XBRIDGE handler into the REAL writers, so the payload the handler builds
 * and the columns the writer binds are proven to line up rather than assumed to.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockDb, createBaseData, createTokenInfo } = require('../fixtures/mocks');
const Utility  = require('../../src/utility.js');
const configjs = require('../../src/config.js');
const Database = require('../../src/db.js');
const XBridge  = require('../../src/actions/xbridge.js');

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST        = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BRIDGE_DOGE = 'mxchainbridgedogeXXXXXXXXXXXXXXXXX';

// In-memory stand-in for one table. Understands only the statement shapes the two
// writers emit, and binds args positionally exactly as those methods pass them, so the
// test cannot drift from the writer's own binding.
function makeTable(name, keyColumns){
    const rows = [];

    const matches = (row, where) => Object.keys(where).every(k => {
        const a = row[k] === undefined ? null : row[k];
        const b = where[k] === undefined ? null : where[k];
        return a === b;
    });

    return {
        name,
        rows,
        query(sql, args){
            const kind = sql.trim().slice(0, 6).toUpperCase();
            if(kind === 'SELECT'){
                const where = {};
                keyColumns.forEach((col, i) => { where[col] = args[i]; });
                return rows.filter(r => matches(r, where));
            }
            if(kind === 'INSERT'){
                // Column order is read out of the statement itself.
                const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                const row  = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                rows.push(row);
                return { affectedRows: 1 };
            }
            if(kind === 'UPDATE'){
                const setCols   = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
                    .split(',').map(s => s.trim().replace(/=\?$/, '').replace(/=\d+$/, '')).filter(Boolean);
                // A literal assignment (`bridged=1`) binds no argument, so it is applied
                // from the statement text; only `col=?` consumes a positional arg.
                const literals  = {};
                sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
                    .split(',').map(s => s.trim())
                    .forEach(frag => {
                        const m = frag.match(/^([a-z_]+)=(\d+)$/);
                        if(m) literals[m[1]] = Number(m[2]);
                    });
                const bound     = setCols.filter(c => !(c in literals));
                const whereFrags = sql.slice(sql.indexOf('WHERE') + 5).split(/\s+AND\s+/).map(s => s.trim());
                const whereCols = [];
                const whereLits = {};
                for(const frag of whereFrags){
                    const lit = frag.match(/^([a-z_]+)\s*=\s*(\d+)$/);
                    if(lit){ whereLits[lit[1]] = Number(lit[2]); continue; }
                    const col = (frag.match(/([a-z_]+)\s*(?:=|<=>)\s*\?/) || [])[1];
                    if(col) whereCols.push(col);
                }
                const setArgs   = args.slice(0, bound.length);
                const whereArgs = args.slice(bound.length);
                const where     = Object.assign({}, whereLits);
                whereCols.forEach((col, i) => { where[col] = whereArgs[i]; });
                const hit = rows.filter(r => matches(r, where));
                for(const row of hit){
                    bound.forEach((col, i) => { row[col] = setArgs[i]; });
                    Object.keys(literals).forEach(col => { row[col] = literals[col]; });
                }
                return { affectedRows: hit.length };
            }
            throw new Error('unexpected statement in test simulator: ' + sql);
        }
    };
}

// A real Database whose doQuery routes to whichever simulated table the statement names,
// and whose four lookup interners hand back stable, distinct ids per value.
function makeDb(tables, ids){
    const config = configjs.getConfig('BTC', 'regtest');
    const util   = new Utility(config);
    const db     = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        for(const table of tables)
            if(new RegExp('\\b' + table.name + '\\b').test(sql))
                return table.query(sql, args);
        throw new Error('no simulated table for: ' + sql);
    });
    const intern = (map, prefix) => async value => {
        if(value === null || value === undefined || value === '') return null;
        const key = String(value);
        if(!(key in map)) map[key] = prefix + (Object.keys(map).length + 1);
        return map[key];
    };
    ids.tick    = ids.tick    || {};
    ids.address = ids.address || {};
    ids.memo    = ids.memo    || {};
    ids.status  = ids.status  || {};
    sinon.stub(db, 'createTicker').callsFake(intern(ids.tick, 100));
    sinon.stub(db, 'createAddress').callsFake(intern(ids.address, 200));
    sinon.stub(db, 'createMemo').callsFake(intern(ids.memo, 300));
    sinon.stub(db, 'createStatus').callsFake(intern(ids.status, 400));
    return db;
}

// The row shape actions/xbridge.js hands createXbridge: the raw wire clone plus the
// three fields the apply path stamps onto it.
function xbridgeRow(overrides){
    return Object.assign({
        ACTION:       'XBRIDGE',
        ACTION_INDEX: 42,
        BLOCK_INDEX:  100,
        SOURCE:       SOURCE,
        MEMO:         '',
        STATUS:       'valid'
    }, overrides || {});
}

describe('createXbridge() - the xbridges action row @regression', function(){

    afterEach(() => sinon.restore());

    function setup(){
        const xbridges = makeTable('xbridges', ['action_index']);
        const ids      = {};
        return { xbridges, ids, db: makeDb([xbridges], ids) };
    }

    it('records a v3 lock with every field the hub poll reads', async function(){
        const { xbridges, ids, db } = setup();
        await db.createXbridge(xbridgeRow({
            FORMAT: 3, TICK: 'FUFU', DEST_COIN: 'DOGE', DEST_ADDRESS: DEST,
            AMOUNT: '5.25', MEMO: 'note', DECIMALS: 2, MIN_DEPTH: 3, DEST_CHAIN: 'DOGE'
        }));

        assert.strictEqual(xbridges.rows.length, 1, 'a valid lock must leave exactly one row');
        const row = xbridges.rows[0];
        assert.strictEqual(row.action_index,    42);
        assert.strictEqual(row.version,         3);
        assert.strictEqual(row.tick_id,         ids.tick['FUFU'], 'the locked tick');
        assert.strictEqual(row.dest_chain,      'DOGE');
        assert.strictEqual(row.dest_address_id, ids.address[DEST], 'the credited address');
        assert.strictEqual(row.amount,          '5.25');
        assert.strictEqual(row.decimals,        2,  'the precision the hub signs');
        assert.strictEqual(row.min_depth,       3,  'the stamped confirmation depth');
        assert.strictEqual(row.memo_id,         ids.memo['note']);
        assert.strictEqual(row.status_id,       ids.status['valid']);
        assert.strictEqual(row.block_index,     100);
    });

    it('records the GAS tick for v0 and v1, which carry no TICK field on the wire', async function(){
        const { xbridges, ids, db } = setup();
        await db.createXbridge(xbridgeRow({
            ACTION_INDEX: 10, FORMAT: 0, DEST_COIN: 'DOGE', DEST_ADDRESS: DEST,
            AMOUNT: '5', DECIMALS: 8, MIN_DEPTH: 0, DEST_CHAIN: 'DOGE'
        }));
        await db.createXbridge(xbridgeRow({
            ACTION_INDEX: 11, FORMAT: 1, BTC_ADDRESS: DEST,
            AMOUNT: '2', DECIMALS: 8, MIN_DEPTH: 0, DEST_CHAIN: 'BTC'
        }));

        const gasId = ids.tick['XCHAIN'];
        assert.ok(gasId, 'the GAS tick was never interned, so no v0/v1 row names an asset');
        assert.deepStrictEqual(xbridges.rows.map(r => [r.version, r.tick_id]),
            [[0, gasId], [1, gasId]]);
    });

    it('takes the destination address from the field THIS version actually carries', async function(){
        const { xbridges, ids, db } = setup();
        const origin = 'mgKgHnTkQrJrnvMZLFhgFqLDjJmQnMYhRY';
        // v1 names a BTC address, v4 names an address on the bridged row's origin chain,
        // and neither carries DEST_ADDRESS. Reading DEST_ADDRESS for all four versions
        // would store NULL for every burn, which is the whole release leg.
        await db.createXbridge(xbridgeRow({ ACTION_INDEX: 20, FORMAT: 1, BTC_ADDRESS: DEST,
            AMOUNT: '1', DEST_CHAIN: 'BTC' }));
        await db.createXbridge(xbridgeRow({ ACTION_INDEX: 21, FORMAT: 4, TICK: 'BTC.FUFU',
            ORIGIN_ADDRESS: origin, AMOUNT: '1', DEST_CHAIN: 'BTC' }));

        assert.strictEqual(xbridges.rows[0].dest_address_id, ids.address[DEST]);
        assert.strictEqual(xbridges.rows[1].dest_address_id, ids.address[origin]);
        assert.notStrictEqual(xbridges.rows[1].dest_address_id, null);
        // A v4 records the tick AS NAMED, rooted, because that is the row it burned.
        assert.strictEqual(xbridges.rows[1].tick_id, ids.tick['BTC.FUFU']);
    });

    it('keeps the row for a refused action and leaves the unstamped fields NULL', async function(){
        const { xbridges, ids, db } = setup();
        await db.createXbridge(xbridgeRow({
            FORMAT: 3, TICK: 'FUFU', DEST_COIN: 'DOGE', DEST_ADDRESS: DEST, AMOUNT: '1',
            STATUS: 'invalid: TICK (not bridgeable to DEST_COIN)'
        }));

        assert.strictEqual(xbridges.rows.length, 1, 'a refusal must still be recorded');
        const row = xbridges.rows[0];
        assert.strictEqual(row.status_id, ids.status['invalid: TICK (not bridgeable to DEST_COIN)']);
        // "never reached the token read" and "the issuer set none" are different answers.
        assert.strictEqual(row.decimals,  null);
        assert.strictEqual(row.min_depth, null);
        assert.strictEqual(row.dest_chain, null, 'DEST_CHAIN is stamped by the apply path only');
    });

    it('stores a version of NULL rather than throwing when the action carried none', async function(){
        const { xbridges, db } = setup();
        // The 'invalid: VERSION (unknown)' path: validateFormat accepts a null FORMAT and
        // refuses it, so the writer is still called. A NaN bound to a TINYINT throws under
        // STRICT_TRANS_TABLES, which wedges the block loop instead of recording anything.
        await db.createXbridge(xbridgeRow({ FORMAT: null, STATUS: 'invalid: VERSION (unknown)' }));

        assert.strictEqual(xbridges.rows.length, 1);
        assert.strictEqual(xbridges.rows[0].version, null);
        assert.ok(!Number.isNaN(xbridges.rows[0].version), 'a NaN version would wedge the block loop');
    });

    it('updates in place on a re-parse of the same block instead of duplicating', async function(){
        const { xbridges, ids, db } = setup();
        const row = () => xbridgeRow({ FORMAT: 3, TICK: 'FUFU', DEST_COIN: 'DOGE',
            DEST_ADDRESS: DEST, AMOUNT: '5.25', DECIMALS: 2, MIN_DEPTH: 3, DEST_CHAIN: 'DOGE' });
        await db.createXbridge(row());
        // A rollback and reindex replays the same action under the same action_index.
        await db.createXbridge(row());

        assert.strictEqual(xbridges.rows.length, 1, 'a re-parse must not duplicate the action');
        assert.strictEqual(xbridges.rows[0].amount, '5.25');
        assert.strictEqual(xbridges.rows[0].status_id, ids.status['valid']);
    });

    it('keeps XBRIDGE actions under different action_index values as separate rows', async function(){
        const { xbridges, db } = setup();
        await db.createXbridge(xbridgeRow({ ACTION_INDEX: 50, FORMAT: 0, DEST_ADDRESS: DEST,
            AMOUNT: '1', DEST_CHAIN: 'DOGE' }));
        await db.createXbridge(xbridgeRow({ ACTION_INDEX: 51, FORMAT: 0, DEST_ADDRESS: DEST,
            AMOUNT: '2', DEST_CHAIN: 'DOGE' }));

        assert.strictEqual(xbridges.rows.length, 2);
        assert.deepStrictEqual(xbridges.rows.map(r => r.amount), ['1', '2']);
    });
});

describe('xbridges DDL and the writer agree @regression', function(){

    afterEach(() => sinon.restore());

    // Column names the writer binds. The table simulator above builds its rows from the
    // INSERT's own column list, so every case in this file would pass just as happily
    // against a column the schema does not have; only reading the DDL catches that, and
    // that failure is an errno 1054 mid-block, which every forward channel swallows.
    const DDL = path.join(__dirname, '..', '..', 'src', 'sql', 'xbridges.sql');
    const MIG = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations', '2026-09-12-bridge-tables.sql');

    function declaredColumns(sqlText){
        const body = sqlText.slice(sqlText.indexOf('('), sqlText.lastIndexOf(') ENGINE'));
        return body.split('\n')
            .map(line => line.replace(/--.*$/, '').trim())
            .map(line => (line.match(/^`?([a-z_]+)`?\s+(?:BIGINT|TINYINT|INT|VARCHAR|CHAR|TEXT|MEDIUMTEXT|TIMESTAMP)/i) || [])[1])
            .filter(Boolean);
    }

    it('every column createXbridge binds is declared in src/sql/xbridges.sql', async function(){
        const xbridges = makeTable('xbridges', ['action_index']);
        const db       = makeDb([xbridges], {});
        await db.createXbridge(xbridgeRow({ FORMAT: 0, DEST_ADDRESS: DEST, AMOUNT: '1',
            DECIMALS: 8, MIN_DEPTH: 0, DEST_CHAIN: 'DOGE' }));

        const declared = declaredColumns(fs.readFileSync(DDL, 'utf8'));
        const bound    = Object.keys(xbridges.rows[0]);
        assert.ok(declared.length >= 11, 'the DDL did not parse: ' + JSON.stringify(declared));
        assert.deepStrictEqual(bound.filter(c => !declared.includes(c)), [],
            'createXbridge binds a column xbridges.sql does not declare (errno 1054 mid-block)');
    });

    it('the fresh-build definition and the migration block declare the same columns', function(){
        const definition = declaredColumns(fs.readFileSync(DDL, 'utf8'));
        const migration  = fs.readFileSync(MIG, 'utf8');
        const block      = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS xbridges'));
        assert.deepStrictEqual(declaredColumns(block), definition,
            'a fresh install and a migrated database would disagree on the xbridges shape');
    });
});

describe('setTokenBridged() - the sticky tokens.bridged bit @regression', function(){

    afterEach(() => sinon.restore());

    function setup(){
        const tokens = makeTable('tokens', ['tick_id']);
        const ids    = { tick: { FUFU: 101, OTHER: 102 } };
        const db     = makeDb([tokens], ids);
        tokens.rows.push({ tick_id: 101, bridged: 0 });
        tokens.rows.push({ tick_id: 102, bridged: 0 });
        return { tokens, db };
    }

    it('sets the bit on the locked token and on nothing else', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('FUFU', 500);

        assert.deepStrictEqual(tokens.rows.map(r => [r.tick_id, r.bridged]), [[101, 1], [102, 0]]);
    });

    it('is a no-op for every later lock of the same token', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('FUFU', 500);
        const logged = sinon.stub(console, 'log');
        await db.setTokenBridged('FUFU', 900);
        const secondLockLogged = logged.callCount;
        logged.restore();

        assert.strictEqual(tokens.rows[0].bridged, 1, 'the bit stays set');
        assert.strictEqual(secondLockLogged, 0, 'the WHERE must exclude an already-set bit');
    });

    it('writes nothing for a tick that has no row on this chain', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('NOSUCH', 500);

        assert.deepStrictEqual(tokens.rows.map(r => r.bridged), [0, 0]);
    });
});

describe('XBRIDGE handler into the real writers, end to end @regression', function(){

    afterEach(() => sinon.restore());

    // The real handler over a mock read-side db, with the two WRITERS bound to a real
    // Database over the table simulator. This is what proves the handler's payload and
    // the writer's column binding agree; each side tested alone can be self-consistent
    // and still disagree with the other.
    function setup(){
        const config = configjs.getConfig('BTC', 'regtest');
        config['ADDRESS']['BRIDGE_DOGE']       = BRIDGE_DOGE;
        config['GAS_SCHEDULE']['XBRIDGE_BASE'] = 5000;

        const util      = new Utility(config);
        const indexerDb = createMockDb();
        const xbridges  = makeTable('xbridges', ['action_index']);
        const tokens    = makeTable('tokens', ['tick_id']);
        const ids       = { tick: { FUFU: 101 } };
        const realDb    = makeDb([xbridges, tokens], ids);
        tokens.rows.push({ tick_id: 101, bridged: 0 });

        indexerDb.createXbridge   = (data) => realDb.createXbridge(data);
        indexerDb.setTokenBridged = (tick, block) => realDb.setTokenBridged(tick, block);
        indexerDb.getTokenInfo.resolves(createTokenInfo({
            TICK: 'FUFU', TICK_ID: 7, DECIMALS: 2, OWNER: SOURCE,
            BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: 3
        }));
        indexerDb.getAddressBalances.resolves({ 7: '100', 1: '100' });

        const handler = new XBridge({
            config, util, indexerDb,
            decoderDb: createMockDb(),
            mapper:    { createMappings: sinon.stub().resolves() },
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true)
            }
        });
        util.resetLists();
        return { handler, xbridges, tokens, ids };
    }

    it('a valid v3 lock leaves an xbridges row and a set bridged bit', async function(){
        const { handler, xbridges, tokens, ids } = setup();
        const data = createBaseData({
            ACTION: 'XBRIDGE', FORMAT: 3, COIN: 'BTC', SOURCE: SOURCE,
            BLOCK_INDEX: 100, ACTION_INDEX: 42, TX_OUTPUTS: []
        });
        await handler.parse(['3', 'FUFU', 'DOGE', DEST, '5.25', ''], data, null);

        assert.strictEqual(data['STATUS'], 'valid', 'the lock itself must apply');
        assert.strictEqual(xbridges.rows.length, 1);
        const row = xbridges.rows[0];
        assert.strictEqual(row.action_index, 42);
        assert.strictEqual(row.version,      3);
        assert.strictEqual(row.tick_id,      ids.tick['FUFU']);
        assert.strictEqual(row.dest_chain,   'DOGE');
        assert.strictEqual(row.amount,       '5.25');
        assert.strictEqual(row.decimals,     2);
        assert.strictEqual(row.min_depth,    3);
        assert.strictEqual(row.block_index,  100);
        assert.strictEqual(tokens.rows[0].bridged, 1, 'the first applied v3 sets the bit');
    });

    it('a refused v3 still leaves its row and never sets the bridged bit', async function(){
        const { handler, xbridges, tokens } = setup();
        const data = createBaseData({
            ACTION: 'XBRIDGE', FORMAT: 3, COIN: 'BTC', SOURCE: SOURCE,
            BLOCK_INDEX: 100, ACTION_INDEX: 43, TX_OUTPUTS: []
        });
        // XCHAIN keeps v0, so a v3 naming the GAS tick is refused before any effect.
        await handler.parse(['3', 'XCHAIN', 'DOGE', DEST, '5', ''], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: TICK (use XBRIDGE v0)');
        assert.strictEqual(xbridges.rows.length, 1, 'the refusal is recorded');
        assert.strictEqual(xbridges.rows[0].dest_chain, null);
        assert.strictEqual(tokens.rows[0].bridged, 0, 'a refused lock must never set the bit');
    });
});
