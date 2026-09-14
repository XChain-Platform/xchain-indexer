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
// XBRIDGE v0: an XCHAIN lock on BTC into the destination chain escrow, its
// destination checks, the amount and fee checks, a sleeping source and the memo cap.
// Part of the XBRIDGE suite; see ../xbridge.test.js. Every expected verdict is a
// literal, for the reason that file gives.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createTokenInfo } = require('../../../fixtures/mocks');
const { SOURCE, DEST, BRIDGE_DOGE, XCHAIN_TICK_ID, makeHandler, makeData, ledger } = require('./helpers/xbridge_context.js');

function setup(opts){
    opts = opts || {};
    let h = makeHandler({ coin: 'BTC' });
    h.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8
    }));
    h.indexerDb.getAddressBalances.resolves(
        opts.balances || { [XCHAIN_TICK_ID]: '100' });
    return h;
}

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v0 lock (XCHAIN, BTC only)', function(){
        it('debits the source, credits the destination chain escrow and charges XBRIDGE_BASE', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', 'note'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(ledger(indexerDb, 'debit'), [
                ['XCHAIN', '5.05', SOURCE]          // 5 locked + 0.05 protocol fee, consolidated
            ]);
            // 5 into the keyless DOGE escrow, 0.05 to the donation address the fee routes to.
            let credits = ledger(indexerDb, 'credit');
            assert.ok(credits.some(c => c[0] === 'XCHAIN' && c[1] === '5' && c[2] === BRIDGE_DOGE),
                'escrow credit missing: ' + JSON.stringify(credits));

            // The row the hub polls carries the destination chain and the signed precision.
            let row = indexerDb.createXbridge.firstCall.args[0];
            assert.strictEqual(row['STATUS'], 'valid');
            assert.strictEqual(row['DEST_CHAIN'], 'DOGE');
            assert.strictEqual(row['DECIMALS'], 8);
            assert.strictEqual(row['AMOUNT'], '5');
        });

        it('never writes an escrow row (the escrow is an ordinary balance)', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexerDb.createEscrow.callCount, 0);
        });

        it('refuses this chain as the destination', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'BTC', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
            assert.strictEqual(indexerDb.createDebit.callCount, 0);
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v0 lock (XCHAIN, BTC only)', function(){
        it('refuses an unsupported destination coin', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'XYZ', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
        });

        it('refuses a destination coin with no escrow address configured', async function(){
            let h = setup();
            delete h.config['ADDRESS']['BRIDGE_LTC'];
            let data = makeData(0, 'BTC');
            await h.handler.parse(['0', 'LTC', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
        });

        it('validates DEST_ADDRESS against the DESTINATION coin and network', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            // A mainnet DOGE address on a regtest rail: right coin, wrong network.
            await handler.parse(['0', 'DOGE', 'DFundmtrigqPCjWQiMFHy1kBzJJQBm9m5Y', '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_ADDRESS');
        });

        it('refuses a zero amount and one past the token DECIMALS', async function(){
            let a = setup();
            let d1 = makeData(0, 'BTC');
            await a.handler.parse(['0', 'DOGE', DEST, '0', ''], d1, null);
            assert.strictEqual(d1['STATUS'], 'invalid: AMOUNT');

            let b = setup();
            let d2 = makeData(0, 'BTC');
            await b.handler.parse(['0', 'DOGE', DEST, '0.000000001', ''], d2, null);
            assert.strictEqual(d2['STATUS'], 'invalid: AMOUNT');
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('v0 lock (XCHAIN, BTC only)', function(){
        it('refuses an amount above the balance', async function(){
            let { handler } = setup({ balances: { [XCHAIN_TICK_ID]: '4' } });
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds');
        });

        it('refuses when the amount fits but the amount plus the fee does not', async function(){
            // The double-spend the in-memory debit closes: on BTC the fee is paid out of the
            // same XCHAIN balance a v0 lock moves, so a 5.00 balance cannot fund a 5 lock
            // AND its 0.05 fee.
            let { handler, indexerDb } = setup({ balances: { [XCHAIN_TICK_ID]: '5' } });
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (FEE)');
            assert.strictEqual(indexerDb.createDebit.callCount, 0);
        });

        it('refuses a sleeping source', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            let h = makeHandler({ coin: 'BTC' });
            h.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8 }));
            h.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '100' });
            h.indexerDb.isActionAllowed.resolves(false);
            await h.handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
            assert.ok(handler);
        });

        it('refuses a memo past MAX_MEMO_LENGTH', async function(){
            let { handler, config } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', 'x'.repeat(config['MAX_MEMO_LENGTH'] + 1)], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (length)');
        });
    });
});
