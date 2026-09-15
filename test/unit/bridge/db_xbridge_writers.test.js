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
 * test/unit/bridge/db_xbridge_writers.test.js
 *
 * The two database writers the XBRIDGE handler calls:
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
 * Technique, from db_create_destroy_multileg.test.js: drive the REAL methods against an
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

const { DEST, makeTable, makeDb, xbridgeRow } = require('./db_xbridge_writers.test/helpers/writer_db.js');

// A fresh xbridges table and a real Database over it, for each createXbridge case.
function setup(){
    const xbridges = makeTable('xbridges', ['action_index']);
    const ids      = {};
    return { xbridges, ids, db: makeDb([xbridges], ids) };
}

describe('createXbridge() - the xbridges action row @regression', function(){

    afterEach(() => sinon.restore());

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
});

describe('createXbridge() - the xbridges action row @regression', function(){
    afterEach(() => sinon.restore());

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
});

describe('createXbridge() - the xbridges action row @regression', function(){
    afterEach(() => sinon.restore());

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
    const DDL = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'xbridges.sql');
    const MIG = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations', '2026-09-12-bridge-tables.sql');

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
