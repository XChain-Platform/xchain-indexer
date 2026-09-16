// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// XBRIDGE v3: a native token locked on its origin chain, the row stamps, the tick
// shape guards, the issuer opt-in, the token DECIMALS and a list-blocked source.
// Part of the XBRIDGE suite; see ../xbridge.test.js. Every expected verdict is a
// literal, for the reason that file gives.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { SOURCE, DEST, BRIDGE_DOGE, XCHAIN_TICK_ID, TOKEN_TICK_ID, makeHandler, makeData, ledger } = require('./helpers/xbridge_context.js');

function setup(opts){
    opts = opts || {};
    let h = makeHandler({ coin: opts.coin || 'BTC' });
    let info = (opts.tokenInfo === undefined)
        ? createTokenInfo({
            TICK: 'FUFU', TICK_ID: TOKEN_TICK_ID, DECIMALS: 2,
            BRIDGE_CHAINS: opts.bridgeChains === undefined ? 'DOGE' : opts.bridgeChains,
            MIN_DEPTH: opts.minDepth
        })
        : opts.tokenInfo;
    h.indexerDb.getTokenInfo.resolves(info);
    h.indexerDb.getAddressBalances.resolves(opts.balances || {
        [TOKEN_TICK_ID]: '100', [XCHAIN_TICK_ID]: '10'
    });
    return h;
}

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v3 lock (a native token on its origin chain)', function(){
        it('locks into the destination escrow and stamps the row DECIMALS and MIN_DEPTH', async function(){
            let { handler, indexerDb } = setup({ minDepth: 3 });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '5.25', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(ledger(indexerDb, 'credit').some(c => c[0] === 'FUFU' && c[1] === '5.25' && c[2] === BRIDGE_DOGE));
            assert.ok(ledger(indexerDb, 'debit').some(d => d[0] === 'FUFU' && d[1] === '5.25' && d[2] === SOURCE));

            let row = indexerDb.createXbridge.firstCall.args[0];
            assert.strictEqual(row['DECIMALS'], 2, 'decimals are stamped from the origin row');
            assert.strictEqual(row['MIN_DEPTH'], 3, 'min_depth is stamped, not re-read at poll time');
            assert.strictEqual(row['DEST_CHAIN'], 'DOGE');

            // The first applied lock sets the origin row's bridged bit.
            assert.strictEqual(indexerDb.setTokenBridged.callCount, 1);
            assert.strictEqual(indexerDb.setTokenBridged.firstCall.args[0], 'FUFU');
        });

        it('stamps MIN_DEPTH 0 when the issuer set none', async function(){
            let { handler, indexerDb } = setup({ minDepth: null });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['MIN_DEPTH'], 0);
        });

        it('refuses a bridged copy: a rooted name is burned with v4, never locked', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'DOGE.FUFU', 'LTC', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not native here)');
            // The shape guard runs before any read, so no junk ticker id is interned.
            assert.strictEqual(indexerDb.getTokenInfo.callCount, 0);
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v3 lock (a native token on its origin chain)', function(){
        it('refuses the GAS tick in any case: XCHAIN keeps v0', async function(){
            for(let tick of ['XCHAIN', 'xchain']){
                let { handler } = setup();
                let data = makeData(3, 'BTC');
                await handler.parse(['3', tick, 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (use XBRIDGE v0)', tick);
            }
        });

        it('refuses a dotted native name, including a subasset of this chain own root', async function(){
            for(let tick of ['PEPE.CASH', 'BTC.PEPE.CASH', 'BTC.SUB']){
                let { handler } = setup();
                let data = makeData(3, 'BTC');
                await handler.parse(['3', tick, 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (subassets are not bridgeable yet)', tick);
            }
        });

        it('refuses a native tick too long to root, and admits the longest one that fits', async function(){
            // MAX_TICK_LENGTH is 250 and the BTC root costs 4 characters ("BTC" plus the dot).
            let tooLong = 'A'.repeat(247);
            let a = setup();
            let d1 = makeData(3, 'BTC');
            await a.handler.parse(['3', tooLong, 'DOGE', DEST, '1', ''], d1, null);
            assert.strictEqual(d1['STATUS'], 'invalid: TICK (too long to bridge)');

            let longest = 'A'.repeat(246);
            let b = setup();
            let d2 = makeData(3, 'BTC');
            await b.handler.parse(['3', longest, 'DOGE', DEST, '1', ''], d2, null);
            assert.strictEqual(d2['STATUS'], 'valid');
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v3 lock (a native token on its origin chain)', function(){
        it('refuses a destination the issuer never opted into', async function(){
            for(let chains of [null, '', '-', 'LTC']){
                let { handler } = setup({ bridgeChains: chains });
                let data = makeData(3, 'BTC');
                await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridgeable to DEST_COIN)',
                    'BRIDGE_CHAINS=' + chains);
            }
        });

        it('admits a destination listed beside others', async function(){
            let { handler } = setup({ bridgeChains: 'LTC,DOGE' });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('refuses an amount past the token own DECIMALS', async function(){
            let { handler } = setup();
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1.234', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT');
        });

        it('refuses a list-blocked source', async function(){
            let h = setup();
            // Sleep checks pass, the source/tick authorization check does not.
            h.indexerDb.isActionAllowed.callsFake(async (address, tick) => !(address && tick));
            let data = makeData(3, 'BTC');
            await h.handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');
        });
    });
});
