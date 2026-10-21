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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { commitGuardEffects } = require('../../../../src/actions/execute/guard_effects.js');
const { REQUEST_ID_PREIMAGE_FIELDS } = require('../../../../src/actions/attest/constants.js');
const { executeData, buildExecute } = require('./helpers/fixture.js');

const TX_HASH = 'ab'.repeat(32);
const CALLEE = 9;
const EXPECTED_PREIMAGE = TX_HASH + ':3:0:9:0';
const EXPECTED_REQUEST_ID = 'd94796d13362c1bf0c593ba8cf16739a5205260a452fc1e9c771b77f7d41e6ae';

let indexer, actionsCtx, handler, executeCalls, attestCalls;

function requestId(preimage) {
    return crypto.createHash('sha256').update(preimage).digest('hex');
}

function requestPreimage(data) {
    return REQUEST_ID_PREIMAGE_FIELDS.map((field) => String(data[field])).join(':');
}

function emittedExecute() {
    return {
        action: 'EXECUTE',
        params: { contractIndex: CALLEE, method: 'host', params: [], gasLimit: 50000 },
    };
}

function wireNestedHandlers() {
    executeCalls = [];
    attestCalls = [];
    actionsCtx.actionAttest = {
        parse: sinon.stub().callsFake(async (params, data) => {
            data['REQUEST_ID'] = params[1];
            data['CONTRACT_INDEX'] = data['EMITTER'];
            data['STATUS'] = 'valid';
            attestCalls.push(data);
        }),
    };
    actionsCtx.actionExecute = {
        parse: sinon.stub().callsFake(async (params, data) => {
            data['CONTRACT_ACTION_INDEX'] = params[1];
            executeCalls.push(data);
            let preimage = [data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['CALL_PATH'], params[1], 0].join(':');
            await handler.processEmission({
                action: 'ATTEST',
                params: { requestId: requestId(preimage) },
            }, data, 0);
            data['STATUS'] = 'valid';
        }),
    };
}

function guardContext(rootDiscriminator, emissions = [emittedExecute()]) {
    return {
        hostData: {
            ACTION_INDEX: 10,
            BLOCK_INDEX: 321,
            BLOCK_TIME: 1700000000,
            SOURCE: 'source',
            TX_HASH,
            TX_INDEX: 1,
            TX_VOUT: 3,
        },
        opts: { seq: 0 },
        contractIndex: 7,
        guardRootDiscrim: rootDiscriminator,
        derived: 'guard-contract',
        callDepth: 1,
        guardMethod: 'onSend',
        guardParams: ['a'],
        gasBilled: 100,
        guardCeiling: 1000,
        vmResult: { stateChanges: [], stateDeletes: [], emittedActions: emissions },
    };
}

async function commitGuard(rootDiscriminator, emissions) {
    let verdict = await commitGuardEffects.call(handler, guardContext(rootDiscriminator, emissions));
    assert.strictEqual(verdict, null);
}

describe('guard emitted host request id below gate @regression @tier1', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = buildExecute());
        indexer.indexerDb.countContractEmissionsForExecution = sinon.stub().resolves(0);
        wireNestedHandlers();
    });

    afterEach(function () {
        sinon.restore();
    });

    it('collides with the ordinary root host request id under the legacy discriminator', async function () {
        await commitGuard(3);

        assert.strictEqual(executeCalls[0]['ROOT_ACTION_INDEX'], 3);
        assert.strictEqual(executeCalls[0]['EMITTER_PATH'], '');
        assert.strictEqual(executeCalls[0]['CALL_PATH'], '0');
        assert.strictEqual(executeCalls[0]['IS_GUARD_EMISSION'], true);
        assert.strictEqual(attestCalls[0]['CONTRACT_INDEX'], CALLEE);
        assert.strictEqual(requestPreimage(attestCalls[0]), EXPECTED_PREIMAGE);
        assert.strictEqual(attestCalls[0]['REQUEST_ID'], EXPECTED_REQUEST_ID);

        let ordinaryRoot = executeData({
            CONTRACT_ACTION_INDEX: 7,
            TX_HASH,
            TX_VOUT: 3,
            CALL_DEPTH: 0,
            CALL_PATH: '',
        });
        await handler.processEmission(emittedExecute(), ordinaryRoot, 0);

        assert.strictEqual(executeCalls[1]['IS_GUARD_EMISSION'], false);
        assert.strictEqual(requestPreimage(attestCalls[1]), EXPECTED_PREIMAGE);
        assert.strictEqual(attestCalls[1]['REQUEST_ID'], EXPECTED_REQUEST_ID);
        assert.strictEqual(requestPreimage(attestCalls[1]), requestPreimage(attestCalls[0]));
        assert.strictEqual(attestCalls[1]['REQUEST_ID'], attestCalls[0]['REQUEST_ID']);
    });

    it('assigns consecutive call paths to two emissions from one guard', async function () {
        await commitGuard(3, [emittedExecute(), emittedExecute()]);

        assert.deepStrictEqual(executeCalls.map((data) => data['CALL_PATH']), ['0', '1']);
        assert.deepStrictEqual(executeCalls.map((data) => data['EMITTER_PATH']), ['', '']);
        assert.ok(executeCalls.every((data) => data['IS_GUARD_EMISSION'] === true));
    });

    it('offsets the call path by emissions already stored for the host action', async function () {
        indexer.indexerDb.countContractEmissionsForExecution.resolves(1);
        await commitGuard(3);

        assert.strictEqual(executeCalls[0]['CALL_PATH'], '1');
        assert.strictEqual(executeCalls[0]['EMITTER_PATH'], '');
    });

    it('passes a composite guard root discriminator through unchanged', async function () {
        await commitGuard('3.2');

        assert.strictEqual(executeCalls[0]['ROOT_ACTION_INDEX'], '3.2');
        assert.strictEqual(attestCalls[0]['ROOT_ACTION_INDEX'], '3.2');
    });
});
