'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Batch = require('../../../../src/actions/batch.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

describe('BATCH composition limit boundary tests @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Batch(actionsCtx);

        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.createActionIndex.resolves(2);
    });

    afterEach(function () { sinon.restore(); });

    it('BAT-01: BATCH with single sub-action is valid and calls processAction once', async function () {
        const TX_DATA = 'BATCH|0|SEND|0|TEST|100|' + DEST + '|';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 1, 'processAction should be called once');
        assert.strictEqual(actionsCtx.processAction.getCall(0).args[0], 'SEND',
            'first sub-action should be SEND');
    });

    it('BAT-02: BATCH with 1 MINT and 1 ISSUE is valid (each at their per-type limit)', async function () {
        const TX_DATA = 'BATCH|0|ISSUE|0|NEWTOKEN|1000|100|0|Test||||||||||||||||;MINT|0|TEST|50||';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 2,
            'processAction should be called twice');
    });

    it('BAT-03: BATCH with 2 MINTs makes the whole batch invalid; processAction is never called', async function () {
        const TX_DATA = 'BATCH|0|MINT|0|TEST|50||;MINT|0|TEST|50||';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        // The batch-level limit check fires before sub-action dispatch
        assert.ok(data.STATUS.startsWith('invalid'),
            `expected invalid but got: ${data.STATUS}`);
        assert.ok(data.STATUS.includes('MINT'),
            `error should mention MINT, got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 0,
            'processAction should not be called when batch is invalid');
    });

    it('BAT-04: BATCH with 2 ISSUEs makes the whole batch invalid; processAction is never called', async function () {
        const TX_DATA = 'BATCH|0|ISSUE|0|NEWTOKEN|1000|100|0|Test||||||||||||||||;ISSUE|0|OTHER|500|50|0|Test2||||||||||||||||';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'),
            `expected invalid but got: ${data.STATUS}`);
        assert.ok(data.STATUS.includes('ISSUE'),
            `error should mention ISSUE, got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 0,
            'processAction should not be called when batch is invalid');
    });

    it('BAT-05: Nested BATCH makes the whole batch invalid (BATCH limit = 0); processAction is never called', async function () {
        const TX_DATA = 'BATCH|0|BATCH|0|SEND|0|TEST|100|' + DEST + '|';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'),
            `expected invalid but got: ${data.STATUS}`);
        assert.ok(data.STATUS.includes('BATCH'),
            `error should mention BATCH, got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 0,
            'processAction should not be called when batch is invalid');
    });

    it('BAT-06: BATCH with 10 SENDs is valid and calls processAction 10 times', async function () {
        const subCommand = 'SEND|0|TEST|100|' + DEST + '|';
        const TX_DATA    = 'BATCH|0|' + Array(10).fill(subCommand).join(';');
        const params     = ['0'];
        const data       = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 10,
            'processAction should be called once per sub-command');
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(actionsCtx.processAction.getCall(i).args[0], 'SEND',
                `sub-action ${i} should be SEND`);
        }
    });

    it('BAT-07: BATCH with empty action name followed by a valid SEND is handled gracefully', async function () {
        // The empty segment becomes action '': no limit defined for it, so the
        // batch remains valid. processAction is called twice: once for '' and once for 'SEND'.
        const TX_DATA = 'BATCH|0||;SEND|0|TEST|100|' + DEST + '|';
        const params  = ['0'];
        const data    = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA });

        await handler.parse(params, data, null);

        // Batch should remain valid: '' has no limit entry, isEnabled stub returns true
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        assert.strictEqual(actionsCtx.processAction.callCount, 2,
            'processAction should be called for both the empty-name command and SEND');
        assert.strictEqual(actionsCtx.processAction.getCall(1).args[0], 'SEND',
            'second processAction call should be for SEND');
    });
});
