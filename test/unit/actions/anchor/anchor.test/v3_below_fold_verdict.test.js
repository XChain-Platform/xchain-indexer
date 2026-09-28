// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks.js');
const Anchor = require('../../../../../src/actions/anchor/index.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const { v3Params } = require('./helpers/anchor_v3_fixtures.js');

const ANCHOR_GATE = 'anchor_activation.ANCHOR_ACTIVATION';
const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

function fixture(coin, anchorActive, foldActive){
    const action = { config: { COIN: coin, NETWORK: 'regtest' } };
    const handler = new Anchor(action);
    sinon.stub(handler, 'parseCheckpoint').callsFake(async (params, data, error) => {
        data.STATUS = error || 'valid';
    });
    sinon.stub(handler, 'parseFold').resolves();
    sinon.stub(gateRegistry, 'activeAt').callsFake(key => {
        if(key === ANCHOR_GATE) return anchorActive;
        if(key === FOLD_GATE) return foldActive;
        return false;
    });
    return handler;
}

async function parseV3(handler){
    const params = v3Params();
    const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });
    await handler.parse(params, data, null);
    return { params, data };
}

describe('ANCHOR v3 below fold verdict @regression @tier3', function(){
    afterEach(function(){ sinon.restore(); });

    for(const coin of ['DOGE', 'BTC']){
        it('treats inactive v3 as unknown on ' + coin, async function(){
            const handler = fixture(coin, true, false);
            const { params, data } = await parseV3(handler);

            sinon.assert.calledWithExactly(gateRegistry.activeAt, FOLD_GATE,
                'regtest', null, 100, null);
            sinon.assert.notCalled(handler.parseFold);
            sinon.assert.calledOnceWithExactly(handler.parseCheckpoint, params, data,
                'invalid: VERSION (unknown)', 3);
            assert.strictEqual(data.STATUS, 'invalid: VERSION (unknown)');
        });
    }

    it('keeps ANCHOR activation ahead of the v3 fold gate', async function(){
        const handler = fixture('DOGE', false, false);
        const { params, data } = await parseV3(handler);

        sinon.assert.notCalled(handler.parseFold);
        sinon.assert.calledOnceWithExactly(handler.parseCheckpoint, params, data,
            'invalid: ANCHOR before activation', 3);
        assert.strictEqual(data.STATUS, 'invalid: ANCHOR before activation');
    });

    it('dispatches active v3 to the fold parser', async function(){
        const handler = fixture('DOGE', true, true);
        const { params, data } = await parseV3(handler);

        sinon.assert.calledOnceWithExactly(handler.parseFold, params, data, null);
        sinon.assert.notCalled(handler.parseCheckpoint);
    });
});
