// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const metrics = require('../../../src/dispenserDivergenceMetrics.js');
const Dispenser_Close = require('../../../src/actions/dispenser_close.js');
const Dispense = require('../../../src/actions/dispense.js');

// Grab all console.log output during `fn` and return the joined lines.
async function captureLog(fn) {
    const spy = sinon.stub(console, 'log');
    try { await fn(); } finally { spy.restore(); }
    return spy.getCalls().map(c => c.args.join(' '));
}

describe('Dispenser divergence metrics (observability) @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    describe('metrics module', function () {

        it('recordCancel emits a CANCEL line', async function () {
            const lines = await captureLog(() =>
                metrics.recordCancel('BTC', 500, 42, 'addr1'));
            const line = lines.find(l => l.includes('DISPENSER_DIVERGENCE : CANCEL'));
            assert.ok(line, 'a CANCEL line is emitted');
            assert.ok(line.includes('BTC:42'), 'includes coin and dispenser action index');
            assert.ok(line.includes('addr=addr1'), 'includes the dispenser address');
            assert.ok(line.includes('block=500'), 'includes the block height');
        });

        it('recordExpirationEdit tags a shortened window', async function () {
            const lines = await captureLog(() =>
                metrics.recordExpirationEdit('BTC', 501, 42, 'addr1', 2000, 1000));
            const line = lines.find(l => l.includes('EDIT_EXPIRATION'));
            assert.ok(line, 'an EDIT_EXPIRATION line is emitted');
            assert.ok(line.includes('old=2000'), 'includes old expiration');
            assert.ok(line.includes('new=1000'), 'includes new expiration');
            assert.ok(line.includes('delta=shortened'), 'tags the shortened direction');
        });

        it('recordExpirationEdit tags a lengthened window', async function () {
            const lines = await captureLog(() =>
                metrics.recordExpirationEdit('BTC', 502, 42, 'addr1', 1000, 5000));
            const line = lines.find(l => l.includes('EDIT_EXPIRATION'));
            assert.ok(line.includes('delta=lengthened'), 'tags the lengthened direction');
        });

        it('recordRejectedDispense tags the reason', async function () {
            const cancelled = await captureLog(() =>
                metrics.recordRejectedDispense('BTC', 503, 'addr1', 42, 'cancelled'));
            assert.ok(cancelled.find(l => l.includes('DISPENSE_REJECTED') && l.includes('reason=cancelled')),
                'tags a cancelled rejection');
            const expired = await captureLog(() =>
                metrics.recordRejectedDispense('BTC', 504, 'addr2', 43, 'expired'));
            assert.ok(expired.find(l => l.includes('DISPENSE_REJECTED') && l.includes('reason=expired')),
                'tags an expired rejection');
        });

        it('emits a per-block SUMMARY line when the block advances', async function () {
            const lines = await captureLog(() => {
                metrics.recordCancel('BTC', 600, 1, 'addr1');
                metrics.recordExpirationEdit('BTC', 600, 2, 'addr2', 2000, 1000);
                metrics.recordRejectedDispense('BTC', 600, 'addr3', 3, 'cancelled');
                // Advancing to a new block flushes block 600's summary.
                metrics.recordCancel('BTC', 601, 4, 'addr4');
            });
            const summary = lines.find(l => l.includes('DISPENSER_DIVERGENCE : SUMMARY') && l.includes('block=600'));
            assert.ok(summary, 'a summary line is emitted for the finished block');
            assert.ok(summary.includes('cancels=1'), 'summary counts the cancel');
            assert.ok(summary.includes('short=1'), 'summary counts the shortened edit');
            assert.ok(summary.includes('cancelled=1'), 'summary counts the rejected dispense');
            assert.ok(summary.includes('| totals'), 'summary carries running totals for multi-day tally');
        });
    });

    describe('dispenser_close call site', function () {
        let indexer, ctx, handler;

        beforeEach(function () {
            indexer = createMockIndexer();
            ctx = {
                config: indexer.config,
                util: indexer.util,
                mapper: indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                processAction: sinon.stub().resolves(),
            };
            handler = new Dispenser_Close(ctx);
            indexer.util.resetLists();
            indexer.indexerDb.getDispenserInfo.resolves({
                ACTION_INDEX: 50, SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                GIVE_TICK: 'TEST', GIVE_REMAINING: '0', GET_ADDRESS: 'get-addr',
            });
        });

        it('records a cancel when DISPENSER_STATUS is "cancelled"', async function () {
            const spy = sinon.spy(metrics, 'recordCancel');
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 700, DISPENSER_STATUS: 'cancelled' });
            await handler.parse(null, data, null);
            sinon.assert.calledOnce(spy);
            assert.strictEqual(spy.firstCall.args[3], 'get-addr', 'passes the dispenser address');
        });

        it('does NOT record a cancel for a normal "empty" auto-close', async function () {
            const spy = sinon.spy(metrics, 'recordCancel');
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 700, DISPENSER_STATUS: 'empty' });
            await handler.parse(null, data, null);
            sinon.assert.notCalled(spy);
        });
    });

    describe('dispense zero-match call site', function () {
        let indexer, ctx, dispense;

        beforeEach(function () {
            indexer = createMockIndexer();
            ctx = {
                config: indexer.config,
                util: indexer.util,
                mapper: indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                processAction: sinon.stub().resolves(),
            };
            dispense = new Dispense(ctx);
            indexer.util.resetLists();
            // No open dispenser matches this trigger.
            indexer.indexerDb.findMatchingDispensers.resolves([]);
        });

        it('records a rejected dispense when the address held a closed dispenser', async function () {
            indexer.indexerDb.getClosedDispenserAtAddress.resolves({ ACTION_INDEX: 88, REASON: 'cancelled' });
            const spy = sinon.spy(metrics, 'recordRejectedDispense');
            const data = createBaseData({ ACTION: 'DISPENSE', COIN_DESTINATION: 'paid-addr', BLOCK_INDEX: 800 });
            await dispense.parse([], data, false);
            // The drop is unchanged (behavior preserved) ...
            sinon.assert.calledOnce(indexer.indexerDb.deleteActionIndex);
            // ... and the divergence is observed with the resolved reason + dispenser.
            sinon.assert.calledOnce(spy);
            assert.strictEqual(spy.firstCall.args[2], 'paid-addr', 'passes the paid address');
            assert.strictEqual(spy.firstCall.args[3], 88, 'passes the resolved dispenser action index');
            assert.strictEqual(spy.firstCall.args[4], 'cancelled', 'passes the reason');
        });

        it('does NOT record when no closed dispenser existed at the address', async function () {
            indexer.indexerDb.getClosedDispenserAtAddress.resolves(false);
            const spy = sinon.spy(metrics, 'recordRejectedDispense');
            const data = createBaseData({ ACTION: 'DISPENSE', COIN_DESTINATION: 'paid-addr', BLOCK_INDEX: 800 });
            await dispense.parse([], data, false);
            sinon.assert.calledOnce(indexer.indexerDb.deleteActionIndex);
            sinon.assert.notCalled(spy);
        });
    });
});
