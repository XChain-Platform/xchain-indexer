// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A BATCH pre-flight reports a filling ORDER sub-command by its OWN verdict.
//
// ORDER dispatches ORDER_MATCH with its own record, and a native-coin match overwrites that
// record's STATUS with 'pending_coinpay'. processAction snapshots the originating verdict in
// _primaryVerdict for exactly this, but the batch probe read the overwritten STATUS, so an
// ORDER the chain accepts was listed as rejected. These cases run the real Batch.parse
// through the real processAction capture, with only the ORDER and ORDER_MATCH bodies stubbed.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Actions = require('../../../src/actions/index.js');
const Batch   = require('../../../src/actions/batch/index.js');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const MATCH_INDEX = 900;

// Two filling ORDERs around a plain SEND.
const WIRE = 'BATCH|0|ORDER|0|BTC||1|0|BTC|AAA|10|0;SEND|0|TEST|5|' + DEST + ';ORDER|0|BTC||2|0|BTC|BBB|20|0';

let indexer, ctx, handler;

function makeCtx(){
    indexer = createMockIndexer();
    let matchStub = { parse: sinon.stub().callsFake(async (params, data) => {
        // What order_match/settle.js does to the ORDER's own record on a native-coin fill.
        data['STATUS'] = 'pending_coinpay';
        data['ACTION_INDEX'] = MATCH_INDEX;
    }) };
    let orderStub = { parse: sinon.stub().callsFake(async (params, data) => {
        data['STATUS'] = 'valid';
        await ctx.processAction('ORDER_MATCH', null, data, null);
    }) };
    let sendStub = { parse: sinon.stub().callsFake(async (params, data) => {
        data['STATUS'] = 'invalid: insufficient funds';
    }) };
    ctx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        isBatchProbeForbiddenSubAction: Actions.isBatchProbeForbiddenSubAction,
        actionAliases:   {},
        _actionCounters: {},
        _primaryVerdict: null,
        assignActionAddressIds: async () => {},
        actionOrder:      orderStub,
        actionOrderMatch: matchStub,
        actionSend:       sendStub,
        processAction:    Actions.prototype.processAction
    };
    handler = new Batch(ctx);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.util.resetLists();
}

function txData(probe){
    let extra = probe ? { FEE_PROBE: true } : {};
    return createBaseData(Object.assign({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE }, extra));
}

describe('BATCH pre-flight : a filling ORDER sub-command answers for itself @regression @tier1', function () {
    beforeEach(makeCtx);
    afterEach(function () { sinon.restore(); });

    it('lists the ORDER as valid, not as its match\'s pending_coinpay', async function () {
        const data = txData(true);
        await handler.parse(['0'], data, null);
        const v = data['PROBE_SUB_VERDICTS'];
        assert.strictEqual(v.length, 3);
        assert.strictEqual(v[0].action, 'ORDER');
        assert.strictEqual(v[0].status, 'valid', 'pending_coinpay reads as a rejection of an order the chain accepts');
    });

    it('gives every filling ORDER its own snapshot, not just the first', async function () {
        const data = txData(true);
        await handler.parse(['0'], data, null);
        assert.strictEqual(data['PROBE_SUB_VERDICTS'][2].action, 'ORDER');
        assert.strictEqual(data['PROBE_SUB_VERDICTS'][2].status, 'valid');
    });

    it('a sub-command with no match keeps the status it really got', async function () {
        const data = txData(true);
        await handler.parse(['0'], data, null);
        assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'][1],
            { position: 1, action: 'SEND', status: 'invalid: insufficient funds', refused: null },
            'an earlier ORDER\'s snapshot must not leak into the next sub-command');
    });

    it('leaves no sub-command\'s snapshot behind to answer for the batch', async function () {
        const data = txData(true);
        await handler.parse(['0'], data, null);
        assert.strictEqual(ctx._primaryVerdict, null, 'the batch-level verdict and fee must not be an ORDER\'s');
        assert.strictEqual(data['STATUS'], 'valid', 'the batch\'s own status is restored');
    });

    it('BELOW-PROBE CONTROL: a decoded batch keeps the capture exactly as before', async function () {
        const data = txData(false);
        await handler.parse(['0'], data, null);
        assert.strictEqual(data['PROBE_SUB_VERDICTS'], undefined);
        assert.deepStrictEqual(ctx._primaryVerdict, { status: 'valid', actionIndex: ctx._primaryVerdict.actionIndex },
            'off the probe path the first match is still captured once per transaction');
        assert.notStrictEqual(ctx._primaryVerdict.actionIndex, MATCH_INDEX);
        assert.strictEqual(data['STATUS'], 'pending_coinpay', 'consensus dispatch is untouched');
    });
});
