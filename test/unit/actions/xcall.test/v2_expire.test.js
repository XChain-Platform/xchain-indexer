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
// XCALL v2 expiry. Part of the XCALL suite; see ../xcall.test.js, whose
// describe title the block here repeats so every full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { freshXcall, makeRequestRow } = require('./helpers/xcall_fixtures.js');

let indexer, handler, executeStub;

function freshHandler() {
    ({ indexer, handler, executeStub } = freshXcall());
}

function restoreStubs() {
    sinon.restore();
}

function v2Data(overrides = {}) {
    return createBaseData({
        ACTION: 'XCALL', FORMAT: 2, IS_SYNTHETIC: true,
        CALL_ID: 'c'.repeat(64), BLOCK_INDEX: 301,
        ...overrides,
    });
}

// ───────────────────────────────────────────────────────────────────────
// v2: Expire (system-synthesized) + exactly-once interlock
// ───────────────────────────────────────────────────────────────────────
describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v2: expire', function () {

        it('flips a pending request to expired BEFORE injecting the callback (interlock order)', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const data = v2Data();
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const flip = indexer.indexerDb.updateCrossChainCallRequestStatus;
            assert.ok(flip.calledOnceWith('c'.repeat(64), 'expired', 'expired', '', 301));
            assert.ok(flip.calledBefore(executeStub.parse));
            // Callback delivered with status='expired', empty payload, echoed params.
            const cbParams = executeStub.parse.firstCall.args[0];
            assert.deepStrictEqual(cbParams.slice(0, 3), [0, 5, 'onResult']);
            assert.deepStrictEqual(cbParams.slice(3), ['c'.repeat(64), 'DOGE', 'expired', '', 'ctx']);
        });

        it('the callback runs under the fixed XCALL callback ceiling at depth 0 with the call\'s hops', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.parse(['2', 'c'.repeat(64)], v2Data(), null);
            const emissionData = executeStub.parse.firstCall.args[1];
            assert.strictEqual(emissionData['VM_GAS_LIMIT'], 20000);
            assert.strictEqual(emissionData['CALL_DEPTH'], 0);
            assert.strictEqual(emissionData['CROSS_HOPS'], 1);
            assert.ok(emissionData['IS_EMISSION']);
            assert.match(emissionData['TX_HASH'], /^[0-9a-f]{64}$/); // synthetic, namespaced
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v2: expire', function () {

        it('is a no-op when the request is already terminal (race-protected)', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ request_status: 'completed' }));
            const data = v2Data();
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
        });

        it('rejects user-broadcast v2 (must be system-synthesized)', async function () {
            const data = v2Data({ IS_SYNTHETIC: undefined });
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.match(data['STATUS'], /must be system-synthesized/);
        });
    });
});
