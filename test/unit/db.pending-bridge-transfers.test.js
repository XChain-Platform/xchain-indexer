/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * db.getPendingBridgeTransfers: the source-leg feed behind getpendingbridgetransfers.
 *
 * The read's contract is "one row per VALID, not-yet-finalized source leg", and the
 * second half of that is decided against this indexer's MIRRORED bridge_transfers copy:
 * a leg whose transfer the federation already signed is finalized and must drop out of
 * the feed. A read that returns every leg the chain has ever carried breaks the bridge
 * twice over: the hub's in_flight term sums the chain's whole bridge history (so the
 * invariant reads a permanent deficit on a healthy bridge), and once the chain has
 * carried `limit` finalized legs the ascending LIMIT never reaches a new lock at all.
 *
 * A stubbed doQuery cannot observe a WHERE clause, so these run the real SQL on a real
 * engine: node:sqlite over the project's OWN src/sql DDL (the sqlMigrationDb technique),
 * with the mirror table either on the same handle (single-host deployments, where the
 * exclusion is one SQL statement) or on a separate handle wired through indexer.hubDb
 * (distributed deployments, where the local legs are paged and checked against the
 * mirror). Every behaviour is asserted on BOTH paths.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const { toSqlite }      = require('../helpers/sqlMigrationDb');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '../../src/sql');
const COIN    = 'BTC';

// sqlMigrationDb.toSqlite handles standalone CREATE INDEX statements; the bridge tables
// declare their keys INLINE (UNIQUE KEY name (...), KEY name (...)), which sqlite rejects,
// so the inline forms are rewritten here: UNIQUE KEY keeps its constraint (the uniqueness
// is part of what the read relies on), a plain KEY is dropped together with the comma
// that precedes it. Indexes change plans, never results.
function loadDdl(file){
    return toSqlite(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'))
        .replace(/\bUNIQUE\s+KEY\s+\w+\s*(\([^)]*\))/gi, 'UNIQUE $1')
        .replace(/,([ \t]*--[^\n]*)?\n((?:[ \t]*--[^\n]*\n)*)[ \t]*KEY\s+\w+\s*\([^)]*\)/g, '$1\n$2');
}

function openSqlite(files){
    // node:sqlite is experimental on Node 22 and warns on load; required lazily so only
    // this suite pays for it.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for(const f of files) db.exec(loadDdl(f));
    const run = async (sql, args) => db.prepare(sql).all(...(args || [])).map(r => Object.assign({}, r));
    const insert = (table, row) => {
        const cols = Object.keys(row);
        db.prepare('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
            .run(...cols.map(c => row[c]));
    };
    return { db, run, insert };
}

const LEDGER_TABLES = ['index_statuses.sql', 'index_tickers.sql', 'index_addresses.sql', 'index_transactions.sql',
                       'transactions.sql', 'actions.sql', 'xbridges.sql', 'bridge_transfers.sql'];

// One venue per test: a Database whose doQuery/doQueryStrict run on the ledger sqlite
// handle. `separateMirror` wires a second sqlite handle (holding only bridge_transfers)
// as indexer.hubDb, so _mirrorDb() is a different object exactly as it is on a node
// that follows a remote hub database; the ledger's own bridge_transfers stays EMPTY on
// that shape, which is what proves the read went to the mirror handle and not the ledger.
function makeVenue({ separateMirror }){
    const ledger = openSqlite(LEDGER_TABLES);
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util, hubDb: null };
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    sinon.stub(db, 'doQuery').callsFake(ledger.run);
    sinon.stub(db, 'doQueryStrict').callsFake(ledger.run);

    let mirror = ledger;
    let mirrorHandle = null;
    if(separateMirror){
        mirror = openSqlite(['bridge_transfers.sql']);
        mirrorHandle = { doQuery: sinon.stub().callsFake(mirror.run), doQueryStrict: sinon.stub().callsFake(mirror.run) };
        indexer.hubDb = mirrorHandle;
    }

    let ids = { status: {}, tick: {}, addr: {}, tx: 0 };
    function intern(table, col, value, cache){
        if(cache[value] != null) return cache[value];
        ledger.db.prepare('INSERT OR IGNORE INTO ' + table + ' (' + col + ') VALUES (?)').run(value);
        cache[value] = ledger.db.prepare('SELECT id FROM ' + table + ' WHERE ' + col + ' = ?').get(value).id;
        return cache[value];
    }

    // One XBRIDGE source leg, joined the way the read joins it: an actions row with its
    // transaction and source address, plus the xbridges record with its verdict.
    function seedLeg({ action_index, block_index, version = 3, status = 'valid', tick = 'FUFU', amount = '1.5' }){
        const statusId = intern('index_statuses', 'status', status, ids.status);
        const tickId   = intern('index_tickers',  'tick',   tick,   ids.tick);
        const destId   = intern('index_addresses', 'address', 'DDest' + action_index, ids.addr);
        const srcId    = intern('index_addresses', 'address', 'BSrc'  + action_index, ids.addr);
        const txIndex  = ++ids.tx;
        const hash     = String(action_index).padStart(64, '0');
        ledger.insert('index_transactions', { id: txIndex, hash });
        ledger.insert('transactions', { tx_index: txIndex, block_index, tx_hash_id: txIndex, source_id: srcId });
        ledger.insert('actions', { action_index, block_index, tx_index: txIndex, tx_vout: 0, action_id: 1, action_format: version, source_id: srcId });
        ledger.insert('xbridges', { action_index, version, tick_id: tickId, dest_chain: 'DOGE', dest_address_id: destId,
                                    amount, decimals: 8, min_depth: 0, memo_id: null, status_id: statusId, block_index });
    }

    // One mirrored bridge_transfers row for a source leg on `src_chain`, every NOT NULL
    // column filled the way the hub mirror ingest would fill it.
    function mirrorTransfer({ src_chain = COIN, src_action_index, status = 'finalized' }){
        mirror.insert('bridge_transfers', {
            transfer_id: (src_chain + ':' + src_action_index + ':' + status).padEnd(64, 'f').slice(0, 64),
            snapshot_block: 100, network: 'regtest', src_chain, src_action_index,
            src_address: 'BSrc' + src_action_index, dest_chain: 'DOGE', dest_address: 'DDest' + src_action_index,
            tick: 'FUFU', decimals: 8, amount: '1.5', effective_time: 1700000000, finalizing_view: 0,
            validator_signatures: '[]', status, push_generation: 0
        });
    }

    return { db, seedLeg, mirrorTransfer, mirrorHandle, ledger };
}

afterEach(function(){ sinon.restore(); });

for(const separateMirror of [false, true]){
    const shape = separateMirror ? 'separate mirror handle (indexer.hubDb)' : 'same connection (single-host)';

    describe('db.getPendingBridgeTransfers, ' + shape + ' @regression @tier1', function(){

        it('excludes a leg whose transfer is mirrored finalized, keeps a retracted one and an unmirrored one', async function(){
            const v = makeVenue({ separateMirror });
            v.seedLeg({ action_index: 10, block_index: 100 });
            v.seedLeg({ action_index: 11, block_index: 101 });
            v.seedLeg({ action_index: 12, block_index: 102 });
            v.mirrorTransfer({ src_action_index: 10, status: 'finalized' });
            // The source leg at 11 was reorged and re-mined at the same action_index: its
            // old transfer is retracted and the leg must be offered for signing again.
            v.mirrorTransfer({ src_action_index: 11, status: 'retracted' });

            const rows = await v.db.getPendingBridgeTransfers(100);
            assert.deepStrictEqual(rows.map(r => Number(r.action_index)), [11, 12],
                'leg 10 is finalized and must drop out; 11 (retracted) and 12 (never signed) stay in flight');
        });

        it('a finalized transfer for the same action_index on ANOTHER src_chain does not exclude this chain\'s leg', async function(){
            const v = makeVenue({ separateMirror });
            v.seedLeg({ action_index: 20, block_index: 100 });
            v.mirrorTransfer({ src_chain: 'DOGE', src_action_index: 20, status: 'finalized' });
            const rows = await v.db.getPendingBridgeTransfers(100);
            assert.deepStrictEqual(rows.map(r => Number(r.action_index)), [20]);
        });

        it('the LIMIT applies AFTER the exclusion: 100 finalized legs then one new leg returns the new leg with limit 100', async function(){
            const v = makeVenue({ separateMirror });
            for(let i = 1; i <= 100; i++){
                v.seedLeg({ action_index: i, block_index: 100 + i });
                v.mirrorTransfer({ src_action_index: i, status: 'finalized' });
            }
            v.seedLeg({ action_index: 101, block_index: 201 });

            const rows = await v.db.getPendingBridgeTransfers(100);
            assert.deepStrictEqual(rows.map(r => Number(r.action_index)), [101],
                'the new lock sits past an ascending page of 100 finalized legs; it must still be returned');
        });

        it('caps at `limit` in-flight rows in ascending action_index order', async function(){
            const v = makeVenue({ separateMirror });
            v.seedLeg({ action_index: 5, block_index: 100 });
            v.mirrorTransfer({ src_action_index: 5, status: 'finalized' });
            for(const ai of [9, 7, 8]) v.seedLeg({ action_index: ai, block_index: 100 + ai });
            const rows = await v.db.getPendingBridgeTransfers(2);
            assert.deepStrictEqual(rows.map(r => Number(r.action_index)), [7, 8]);
        });

        it('refused legs and non-bridge versions are never fed, mirrored or not', async function(){
            const v = makeVenue({ separateMirror });
            v.seedLeg({ action_index: 30, block_index: 100, status: 'invalid: insufficient funds' });
            v.seedLeg({ action_index: 31, block_index: 100, version: 2 });   // a settle leg, never a source leg
            v.seedLeg({ action_index: 32, block_index: 100, version: 0 });
            v.seedLeg({ action_index: 33, block_index: 100, version: 1 });
            v.seedLeg({ action_index: 34, block_index: 100, version: 4 });
            const rows = await v.db.getPendingBridgeTransfers(100);
            assert.deepStrictEqual(rows.map(r => Number(r.action_index)), [32, 33, 34]);
        });

        it('returns every PendingBridgeTransfer column the RPC handler maps', async function(){
            const v = makeVenue({ separateMirror });
            v.seedLeg({ action_index: 40, block_index: 140, version: 3, tick: 'FUFU', amount: '10.5' });
            const rows = await v.db.getPendingBridgeTransfers(10);
            assert.strictEqual(rows.length, 1);
            const r = rows[0];
            assert.deepStrictEqual(Object.keys(r).sort(),
                ['action_index', 'amount', 'block_index', 'decimals', 'dest_address', 'dest_chain',
                 'min_depth', 'src_address', 'tick', 'tx_hash', 'version'].sort());
            assert.strictEqual(Number(r.version), 3);
            assert.strictEqual(Number(r.block_index), 140);
            assert.strictEqual(String(r.amount), '10.5');
            assert.strictEqual(r.tick, 'FUFU');
            assert.strictEqual(r.dest_chain, 'DOGE');
            assert.strictEqual(r.dest_address, 'DDest40');
            assert.strictEqual(r.src_address, 'BSrc40');
            assert.strictEqual(r.tx_hash, String(40).padStart(64, '0'));
        });

        it('returns [] on an empty chain and on a fully finalized one', async function(){
            const v = makeVenue({ separateMirror });
            assert.deepStrictEqual(await v.db.getPendingBridgeTransfers(100), []);
            v.seedLeg({ action_index: 50, block_index: 100 });
            v.mirrorTransfer({ src_action_index: 50 });
            assert.deepStrictEqual(await v.db.getPendingBridgeTransfers(100), []);
        });
    });
}

describe('db.getPendingBridgeTransfers, mirror handle discipline @regression @tier1', function(){
    it('reads the mirror through doQueryStrict on a separate handle, never through the swallowing doQuery', async function(){
        // doQuery collapses a non-transactional query error into [], which here would read
        // as "nothing finalized" and silently feed the whole history again (the exact
        // defect this read exists to close). The mirror read must therefore throw.
        const v = makeVenue({ separateMirror: true });
        v.seedLeg({ action_index: 60, block_index: 100 });
        v.mirrorTransfer({ src_action_index: 60 });
        assert.deepStrictEqual(await v.db.getPendingBridgeTransfers(100), []);
        assert.ok(v.mirrorHandle.doQueryStrict.callCount >= 1, 'the mirror must be asked through doQueryStrict');
        assert.strictEqual(v.mirrorHandle.doQuery.callCount, 0, 'the mirror must not be asked through doQuery');
        for(const call of v.mirrorHandle.doQueryStrict.getCalls())
            assert.match(call.args[0], /FROM\s+bridge_transfers/i);
    });

    it('a mirror read failure propagates instead of feeding the whole history', async function(){
        const v = makeVenue({ separateMirror: true });
        v.seedLeg({ action_index: 61, block_index: 100 });
        v.mirrorHandle.doQueryStrict.rejects(new Error('mirror unreachable'));
        await assert.rejects(() => v.db.getPendingBridgeTransfers(100), /mirror unreachable/);
    });

    it('on the single-host shape the ledger connection answers alone (no hubDb handle is consulted)', async function(){
        const v = makeVenue({ separateMirror: false });
        v.seedLeg({ action_index: 70, block_index: 100 });
        v.mirrorTransfer({ src_action_index: 70 });
        assert.deepStrictEqual(await v.db.getPendingBridgeTransfers(100), []);
        assert.strictEqual(v.mirrorHandle, null);
    });
});
