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
// XBRIDGE v4: a bridged copy burned on the chain holding it, and the refusals of a
// native row, a row rooted at this chain, a row the bridge role does not own and a
// bad ORIGIN_ADDRESS.
// Part of the XBRIDGE suite; see ../xbridge.test.js. Every expected verdict is a
// literal, for the reason that file gives.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { SOURCE, DEST, BRIDGE_BTC, XCHAIN_TICK_ID, TOKEN_TICK_ID, makeHandler, makeData, ledger } = require('./helpers/xbridge_context.js');

function setup(opts){
    opts = opts || {};
    let h = makeHandler({ coin: 'DOGE', noFeeDestination: true });
    h.indexerDb.getTokenInfo.resolves(opts.tokenInfo === undefined
        ? createTokenInfo({
            TICK: 'BTC.FUFU', TICK_ID: TOKEN_TICK_ID, DECIMALS: 2,
            OWNER: (opts.owner === undefined) ? BRIDGE_BTC : opts.owner
        })
        : opts.tokenInfo);
    h.indexerDb.getAddressBalances.resolves(opts.balances || {
        [TOKEN_TICK_ID]: '100', [XCHAIN_TICK_ID]: '10'
    });
    return h;
}

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v4 burn (a bridged copy on the chain holding it)', function(){
        it('debits the copy and names the origin chain, with no bridged bit to set', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', DEST, '2', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(ledger(indexerDb, 'debit').some(d => d[0] === 'BTC.FUFU' && d[1] === '2' && d[2] === SOURCE));
            assert.ok(!ledger(indexerDb, 'credit').some(c => c[0] === 'BTC.FUFU'),
                'a burn must credit nobody the burned tick');
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['DEST_CHAIN'], 'BTC');
            assert.strictEqual(indexerDb.setTokenBridged.callCount, 0);
        });

        it('refuses a native row: a burn needs a bridged copy', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
            assert.strictEqual(indexerDb.getTokenInfo.callCount, 0);
        });

        it('refuses a row rooted at this chain own coin', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'DOGE.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
        });

        it('refuses a rooted row the bridge role does not own', async function(){
            let { handler } = setup({ owner: SOURCE });
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
        });

        it('validates ORIGIN_ADDRESS against the ORIGIN chain', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', 'not-an-address', '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: ORIGIN_ADDRESS');
        });
    });

    describe('v4 burn (a bridged copy on the chain holding it)', function(){
        it('reaches the same row and the same verdict for a lower-case root', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'btc.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
