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
 * oraclefeequote sizes the oracle fee from giveEscrow, so a value the
 * dispenser create check would never accept (a sign, an exponent, hex, a
 * container) must get a parameter error before any read or quote, rather
 * than a valid:true answer carrying a negative fee. Shapes consensus does
 * accept, zero-padded or trailing-dot, must reach the quote unchanged.
 */

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { buildFeesRpc } = require('../../../../../src/api/rpc/fees.js');

const BASE = { oracleAddress: 'unknownaddr', giveCoin: 'BTC', giveTick: 'XCP', fiatCode: 'USD' };
const REFUSED = { error: 'giveEscrow must be a non-negative decimal' };

function feesRpc(){
    const db = {
        getLatestBlockIndex: sinon.stub().resolves(5),
        getBlockTime:        sinon.stub().resolves(1700000000),
    };
    const util = { quoteOracleFee: sinon.spy(async () => ({ valid: false, error: 'no price' })) };
    const indexerDb = { apiView: () => db };
    return { rpc: buildFeesRpc({ indexer: { indexerDb, util, config: { COIN: 'BTC' } } }), db, util };
}

async function quote(giveEscrow){
    const ctx = feesRpc();
    const res = await ctx.rpc.oraclefeequote(Object.assign({}, BASE, { giveEscrow }));
    return Object.assign(ctx, { res });
}

afterEach(function () {
    sinon.restore();
});

describe('oraclefeequote giveEscrow parsing @regression @tier1', function () {
    it('refuses a negative, exponent, non-decimal or oversized giveEscrow before quoting', async function () {
        for(const value of ['-1', '-0.5', '1e3', '0x10', ' 5 ', '', [], {}, true, -5, '1'.repeat(81)]){
            const { res, db, util } = await quote(value);
            assert.deepStrictEqual(res, REFUSED, JSON.stringify(value));
            sinon.assert.notCalled(db.getLatestBlockIndex);
            sinon.assert.notCalled(util.quoteOracleFee);
        }
    });

    it('passes a canonical giveEscrow to the quote and leaves an omitted one omitted', async function () {
        for(const [value, expected] of [['1000.5', '1000.5'], [0, 0], [undefined, undefined], [null, null]]){
            const { util } = await quote(value);
            sinon.assert.calledOnce(util.quoteOracleFee);
            assert.strictEqual(util.quoteOracleFee.firstCall.args[1].GIVE_ESCROW, expected);
        }
    });

    it('quotes a zero-padded or trailing-dot giveEscrow that consensus accepts', async function () {
        for(const value of ['007', '05.5', '5.', '0', '1'.repeat(80)]){
            const { util } = await quote(value);
            sinon.assert.calledOnce(util.quoteOracleFee);
            assert.strictEqual(util.quoteOracleFee.firstCall.args[1].GIVE_ESCROW, value);
        }
    });

    it('refuses a bare-dot or multi-dot giveEscrow that consensus also refuses', async function () {
        for(const value of ['.5', '1.2.3', '.']){
            const { res, util } = await quote(value);
            assert.deepStrictEqual(res, REFUSED, value);
            sinon.assert.notCalled(util.quoteOracleFee);
        }
    });
});
