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
 * test/unit/issue-bridge-storage.test.js
 *
 * The storage half of the token-bridge opt-in, driven against the real db.js
 * methods with a stubbed query layer:
 *
 *   - createIssue writes the three RAW WIRE fields to `issues`, which is what makes
 *     "empty means unchanged" true, and its placeholder/argument alignment holds
 *     (a silent off-by-one here writes every later column into the wrong slot);
 *   - createToken writes the PARSED values to `tokens`, folds the '-' sentinel to
 *     NULL so the column always reads as the effective destination list, and never
 *     writes `bridged`, which only an applied XBRIDGE v3 lock may set;
 *   - getTokenInfo replays BRIDGE_CHAINS / MIN_DEPTH / LOCK_BRIDGE out of `issues`
 *     with the empty-means-unchanged and cannot-unset rules the other fields get,
 *     and reads BRIDGED as current state rather than replaying it;
 *   - isAddressSleeping judges a foreign-format address instead of skipping it once
 *     TOKEN_POLICY_INHERITANCE_ACTIVATION is armed.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Database              = require('../../src/db.js');
const Utility               = require('../../src/utility.js');
const { getTestConfig }     = require('../fixtures/config');
const tokenPolicyActivation = require('../../src/token_policy_activation.js');

const BTC_MAINNET  = '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA';
const DOGE_MAINNET = 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW';

// A Database with the real methods and a stubbed query layer, so the SQL these rows
// actually produce is what gets asserted.
function makeDb({ coin = 'BTC', network = 'mainnet' } = {}){
    const config = getTestConfig();
    config.COIN    = coin;
    config.NETWORK = network;
    const db = Object.create(Database.prototype);
    db.config        = config;
    db.util          = new Utility(config);
    db.doQuery       = sinon.stub().resolves([]);
    db.createTicker  = sinon.stub().resolves(1);
    db.createAddress = sinon.stub().resolves(1);
    db.createMemo    = sinon.stub().resolves(1);
    db.createStatus  = sinon.stub().resolves(1);
    db.getTokenSupply = sinon.stub().resolves('0');
    return db;
}

// One row of the getTokenInfo projection, as MariaDB hands it back.
function issueRow(o = {}){
    return Object.assign({
        max_supply: '1000', max_mint: '0', decimals: 0, description: 'test',
        lock_max_supply: 0, lock_mint_supply: 0, lock_mint: 0, lock_max_mint: 0,
        lock_description: 0, lock_sleep: 0, lock_callback: 0,
        callback_block: 0, callback_amount: 0, mint_address_max: 0,
        mint_start_block: 0, mint_stop_block: 0, allow_list: null, block_list: null,
        bridge_chains: null, min_depth: null, lock_bridge: null,
        action_index: 10, block_index: 100, tick: 'FUFU', callback_tick: null,
        owner: BTC_MAINNET, transfer: null, bridged: 0
    }, o);
}

describe('token-bridge opt-in storage @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('createIssue (issues, raw wire strings)', function(){

        it('carries the three wire fields into the INSERT, in argument order', async function(){
            const db = makeDb();
            await db.createIssue({
                ACTION_INDEX: 5, TICK: 'FUFU', STATUS: 'valid', MEMO: '',
                BRIDGE_CHAINS: 'DOGE,LTC', MIN_DEPTH: '3', LOCK_BRIDGE: '1'
            });
            const [sql, args] = db.doQuery.lastCall.args;
            assert.ok(/INSERT INTO issues/.test(sql));
            const columns      = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
            const placeholders = (sql.slice(sql.lastIndexOf('values')).match(/\?/g) || []).length;
            assert.strictEqual(columns.length, placeholders, 'column count must equal placeholder count');
            assert.strictEqual(columns.length, args.length, 'argument count must equal column count');
            assert.strictEqual(args[columns.indexOf('bridge_chains')], 'DOGE,LTC');
            assert.strictEqual(args[columns.indexOf('min_depth')], '3');
            assert.strictEqual(args[columns.indexOf('lock_bridge')], '1');
        });

        it('stores an omitted field as SQL NULL, which is what "unchanged" means here', async function(){
            const db = makeDb();
            await db.createIssue({ ACTION_INDEX: 5, TICK: 'FUFU', STATUS: 'valid', MEMO: '' });
            const [sql, args] = db.doQuery.lastCall.args;
            const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
            // null and undefined both bind as SQL NULL; which one an action carries depends
            // on whether its format string names the field at all, and both must replay as
            // "this ISSUE did not carry the field" through getTokenInfo.
            for(const col of ['bridge_chains', 'min_depth', 'lock_bridge'])
                assert.ok(args[columns.indexOf(col)] == null, col + ' must bind as NULL when the action omits it');
        });
    });

    describe('createToken (tokens, parsed state)', function(){

        it('parses the three fields into the INSERT, in argument order', async function(){
            const db = makeDb();
            await db.createToken({
                ACTION_INDEX: 5, TICK: 'FUFU', OWNER: BTC_MAINNET, DECIMALS: 0,
                BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: '3', LOCK_BRIDGE: '1'
            });
            const [sql, args] = db.doQuery.lastCall.args;
            assert.ok(/INSERT INTO tokens/.test(sql));
            const columns      = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
            const placeholders = (sql.slice(sql.lastIndexOf('values')).match(/\?/g) || []).length;
            assert.strictEqual(columns.length, placeholders, 'column count must equal placeholder count');
            assert.strictEqual(columns.length, args.length, 'argument count must equal column count');
            assert.strictEqual(args[columns.indexOf('bridge_chains')], 'DOGE');
            assert.strictEqual(args[columns.indexOf('min_depth')], 3);
            assert.strictEqual(args[columns.indexOf('lock_bridge')], 1);
        });

        it('folds the "-" sentinel to NULL so the column is the effective list', async function(){
            const db = makeDb();
            await db.createToken({ ACTION_INDEX: 5, TICK: 'FUFU', OWNER: BTC_MAINNET, DECIMALS: 0, BRIDGE_CHAINS: '-' });
            const [sql, args] = db.doQuery.lastCall.args;
            const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
            assert.strictEqual(args[columns.indexOf('bridge_chains')], null);
        });

        it('never writes `bridged`: only an applied XBRIDGE v3 lock may set it', async function(){
            const db = makeDb();
            await db.createToken({ ACTION_INDEX: 5, TICK: 'FUFU', OWNER: BTC_MAINNET, DECIMALS: 0, BRIDGED: 1 });
            const [sql] = db.doQuery.lastCall.args;
            assert.ok(!/\bbridged\b/.test(sql), 'createToken must not write the bridged bit');
        });
    });

    describe('getTokenInfo projection fold', function(){

        it('replays the three fields off the issues rows', async function(){
            const db = makeDb();
            db.doQuery.resolves([issueRow({ bridge_chains: 'DOGE', min_depth: '3', lock_bridge: '1' })]);
            const info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['BRIDGE_CHAINS'], 'DOGE');
            assert.strictEqual(info['MIN_DEPTH'], '3');
            assert.strictEqual(info['LOCK_BRIDGE'], '1');
        });

        it('inherits an empty field from the prior ISSUE, so empty means unchanged', async function(){
            const db = makeDb();
            db.doQuery.resolves([
                issueRow({ action_index: 10, bridge_chains: 'DOGE', min_depth: '3' }),
                issueRow({ action_index: 11, bridge_chains: '',     min_depth: '' })
            ]);
            const info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['BRIDGE_CHAINS'], 'DOGE');
            assert.strictEqual(info['MIN_DEPTH'], '3');
        });

        it('takes the later explicit "-" sentinel, which is how a list is cleared', async function(){
            const db = makeDb();
            db.doQuery.resolves([
                issueRow({ action_index: 10, bridge_chains: 'DOGE' }),
                issueRow({ action_index: 11, bridge_chains: '-' })
            ]);
            const info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['BRIDGE_CHAINS'], '-');
        });

        it('never lets LOCK_BRIDGE be unset once set, the shared LOCK_ rule', async function(){
            const db = makeDb();
            db.doQuery.resolves([
                issueRow({ action_index: 10, lock_bridge: 1 }),
                issueRow({ action_index: 11, lock_bridge: 0 })
            ]);
            const info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['LOCK_BRIDGE'], 1);
        });

        it('reads BRIDGED as current state, normalized to 0/1', async function(){
            const db = makeDb();
            db.doQuery.resolves([issueRow({ bridged: 1 })]);
            let info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['BRIDGED'], 1);

            db.doQuery.resolves([issueRow({ bridged: null })]);
            info = await db.getTokenInfo('FUFU', 100, 999);
            assert.strictEqual(info['BRIDGED'], 0);
        });

        it('asks for the new columns in the query it actually runs', async function(){
            const db = makeDb();
            db.doQuery.resolves([issueRow()]);
            await db.getTokenInfo('FUFU', 100, 999);
            const sql = db.doQuery.firstCall.args[0];
            for(const col of ['i.bridge_chains', 'i.min_depth', 'i.lock_bridge', 'tk.bridged'])
                assert.ok(sql.includes(col), 'projection must select ' + col);
        });
    });

    describe('isAddressSleeping widening', function(){

        it('skips a foreign-format address below the flag (no query at all)', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(false);
            const db = makeDb({ coin: 'BTC', network: 'mainnet' });
            const sleeping = await db.isAddressSleeping(DOGE_MAINNET, 500);
            assert.strictEqual(sleeping, false);
            assert.strictEqual(db.doQuery.callCount, 0, 'below the flag the address is not an address here');
        });

        it('judges a foreign-format address at/above the flag', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(true);
            const db = makeDb({ coin: 'BTC', network: 'mainnet' });
            db.doQuery.resolves([{ resume_block: -1 }]);
            const sleeping = await db.isAddressSleeping(DOGE_MAINNET, 500);
            assert.strictEqual(sleeping, true);
            assert.strictEqual(db.doQuery.callCount, 1);
        });

        it('still judges a local address below the flag, so nothing historical moves', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(false);
            const db = makeDb({ coin: 'BTC', network: 'mainnet' });
            db.doQuery.resolves([{ resume_block: -1 }]);
            assert.strictEqual(await db.isAddressSleeping(BTC_MAINNET, 500), true);
        });

        it('still rejects a string that is no coin address at all', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(true);
            const db = makeDb({ coin: 'BTC', network: 'mainnet' });
            assert.strictEqual(await db.isAddressSleeping('not-an-address', 500), false);
            assert.strictEqual(db.doQuery.callCount, 0);
        });
    });
});
