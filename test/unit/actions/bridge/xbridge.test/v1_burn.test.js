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
// XBRIDGE v1: an XCHAIN burn off BTC that lowers supply, and its address, row and
// native fee refusals.
// Part of the XBRIDGE suite; see ../xbridge.test.js. Every expected verdict is a
// literal, for the reason that file gives.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { SOURCE, DEST, XCHAIN_TICK_ID, makeHandler, makeData, ledger } = require('./helpers/xbridge_context.js');

function setup(opts){
    opts = opts || {};
    let h = makeHandler(Object.assign({ coin: 'DOGE' }, opts));
    h.indexerDb.getTokenInfo.resolves(opts.tokenInfo === undefined
        ? createTokenInfo({ TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8 })
        : opts.tokenInfo);
    h.indexerDb.getAddressBalances.resolves(opts.balances || { [XCHAIN_TICK_ID]: '100' });
    return h;
}

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v1 burn (XCHAIN, never on BTC)', function(){
        it('debits the source with no offsetting credit, so supply falls', async function(){
            let { handler, indexerDb } = setup({ noFeeDestination: true });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            // 2 burned + 0.05 fee, both debits; the only credit is the fee donation.
            assert.deepStrictEqual(ledger(indexerDb, 'debit'), [['XCHAIN', '2.05', SOURCE]]);
            let credits = ledger(indexerDb, 'credit');
            assert.ok(!credits.some(c => c[1] === '2'), 'a burn must credit nobody the burned amount');
            // Supply is recomputed from the ledger at the end of the action.
            assert.strictEqual(indexerDb.updateTokens.callCount, 1);
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['DEST_CHAIN'], 'BTC');
        });

        it('refuses a BTC_ADDRESS that is not a BTC address on this network', async function(){
            let { handler } = setup({ noFeeDestination: true });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', 'not-an-address', '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: BTC_ADDRESS');
        });

        it('refuses when this chain holds no XCHAIN row yet', async function(){
            let { handler } = setup({ noFeeDestination: true, tokenInfo: false });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (unknown)');
        });

        it('refuses off BTC when the protocol fee has no native coin output', async function(){
            // detectFeePaymentMode rejects a missing fee output off BTC rather than falling
            // back to an XCHAIN debit, which is what the XBRIDGE_BASE floor is sized for.
            let { handler } = setup();
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });
    });
});
