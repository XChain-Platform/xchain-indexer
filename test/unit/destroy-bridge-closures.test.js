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
 * test/unit/destroy-bridge-closures.test.js
 *
 * DESTROY's two bridge closures. DESTROY lowers a token's SUPPLY with no
 * counterpart anywhere, which is exactly wrong for a supply that is the shadow of
 * an escrow balance held on another chain: burned here, the escrow on the origin
 * chain is stranded forever and the bridge invariant reads a permanent surplus
 * nobody can redeem.
 *
 *   - XCHAIN off BTC     -> 'invalid: TICK (use XBRIDGE v1)'
 *   - a bridged copy     -> 'invalid: TICK (use XBRIDGE v4)'
 *
 * Both are UNCONDITIONAL, not activation-keyed (base spec D62): no off-BTC XCHAIN
 * row exists to destroy, and no <ORIGIN>.<NAME> row can exist before the bridge
 * creates one, so neither refusal can move a historical verdict.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Destroy = require('../../src/actions/destroy.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function makeActionsCtx(indexer){
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction:   sinon.stub().resolves(),
    };
}

function tokenRow(tick){
    return {
        TICK: tick, TICK_ID: 7, OWNER: SOURCE, DECIMALS: 0, SUPPLY: '1000',
        MAX_SUPPLY: '1000', ALLOW_LIST: null, BLOCK_LIST: null
    };
}

// DESTROY format 0: VERSION|TICK|AMOUNT|MEMO
async function runDestroy({ tick, coin = 'DOGE', network = 'regtest' }){
    const indexer = createMockIndexer();
    indexer.config.COIN    = coin;
    indexer.config.NETWORK = network;
    // The mock builds its Utility from its own config snapshot, so the chain identity has
    // to be set on both objects: parseBridgedTick decides "is this a bridged copy" from the
    // UTILITY's coin, which in production is the same object the handler holds.
    indexer.util.config.COIN    = coin;
    indexer.util.config.NETWORK = network;
    // Every tick this action touches (the destroyed tick and the GAS tick the guard-gas
    // context loads) resolves to a real row, so the refusal under test is the first thing
    // the leg can fail on rather than 'TICK (unknown)'.
    indexer.indexerDb.getTokenInfo.callsFake(async (t) => tokenRow(String(t)));
    indexer.indexerDb.isActionAllowed.resolves(true);

    const handler = new Destroy(makeActionsCtx(indexer));
    const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, BLOCK_INDEX: 500, SOURCE: SOURCE });
    await handler.parse(['0', tick, '1', ''], data, null);
    return data.STATUS;
}

describe('DESTROY bridge supply-path closures @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    it('refuses a DESTROY of XCHAIN on DOGE, naming XBRIDGE v1', async function(){
        assert.strictEqual(await runDestroy({ tick: 'XCHAIN', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v1)');
    });

    it('refuses it on LTC too', async function(){
        assert.strictEqual(await runDestroy({ tick: 'XCHAIN', coin: 'LTC' }), 'invalid: TICK (use XBRIDGE v1)');
    });

    it('refuses it on DOGE mainnet: the closure is not network-keyed', async function(){
        assert.strictEqual(await runDestroy({ tick: 'XCHAIN', coin: 'DOGE', network: 'mainnet' }), 'invalid: TICK (use XBRIDGE v1)');
    });

    it('is case-folded, so the lower-case spelling of the gas tick is refused too', async function(){
        assert.strictEqual(await runDestroy({ tick: 'xchain', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v1)');
    });

    it('leaves a DESTROY of XCHAIN on BTC alone: that is the real burn path', async function(){
        assert.notStrictEqual(await runDestroy({ tick: 'XCHAIN', coin: 'BTC' }), 'invalid: TICK (use XBRIDGE v1)');
    });

    it('refuses a DESTROY of a bridged copy, naming XBRIDGE v4', async function(){
        assert.strictEqual(await runDestroy({ tick: 'BTC.FUFU', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v4)');
    });

    it('is case-folded on the origin prefix, which every tick lookup already is', async function(){
        assert.strictEqual(await runDestroy({ tick: 'btc.FUFU', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v4)');
    });

    it('leaves an ordinary subasset of a locally-rooted name alone', async function(){
        assert.notStrictEqual(await runDestroy({ tick: 'DOGE.FUFU', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v4)');
    });

    it('leaves an ordinary user subasset alone', async function(){
        assert.notStrictEqual(await runDestroy({ tick: 'JDOG.1', coin: 'DOGE' }), 'invalid: TICK (use XBRIDGE v4)');
    });

    it('leaves a plain native token alone', async function(){
        // The mock SOURCE holds no balances, so this leg ends at the ordinary funds check;
        // what matters is that neither closure claimed it first.
        const status = await runDestroy({ tick: 'FUFU', coin: 'DOGE' });
        assert.notStrictEqual(status, 'invalid: TICK (use XBRIDGE v1)');
        assert.notStrictEqual(status, 'invalid: TICK (use XBRIDGE v4)');
    });
});
