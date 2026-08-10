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
// Dispenser settlement must be once-only at the handler that MOVES the escrow.
//
// GIVE_REMAINING is derived (give_escrow + dispenser_edits - valid dispenses) and a
// close/expire inserts no dispenses row and does not zero give_escrow, so a second
// settlement of the same dispenser recomputes the identical non-zero remaining and
// refunds it a second time: the recipient is double-credited, the global escrow sum
// goes negative, the supply SanityError in updateAddressBalances trips, and the
// indexer crash-loops on that block. Until util.isDispenserSettled() the guarantee
// rested entirely on caller-side status filters (getExpiredItems 'open',
// findCancelledDispensers 'cancelling') while the ownership branch of the same two
// handlers already carried its own local guard.
//
// Both directions are pinned here, because the dangerous half of this fix is the
// other one: a guard that skipped a LEGITIMATE first refund would strand a user's
// escrow forever and fork the chain against every node running the unguarded code.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Dispenser_Close  = require('../../../src/actions/dispenser_close.js');
const Dispenser_Expire = require('../../../src/actions/dispenser_expire.js');

// Statuses a dispenser can legitimately carry when a settlement handler first runs.
// close is entered at 'cancelling' (utility.processCancellations) and at 'open' (the
// dispense.js auto-closes, whose dispenser was matched under findMatchingDispensers'
// own `status IN ('open','cancelling')` filter); expire only ever at 'open'.
const LIVE_STATUSES = ['open', 'cancelling'];

// Statuses written BY a settlement, i.e. every state that means "already refunded".
// dispenser_close writes data['DISPENSER_STATUS'] ('cancelled' from
// processCancellations, 'empty' and 'max_dispenses_reached' from dispense.js) and
// dispenser_expire writes 'expired'.
const SETTLED_STATUSES = ['cancelled', 'empty', 'max_dispenses_reached', 'expired'];

describe('Dispenser settlement idempotency (double-refund guard) @regression @tier1', function () {
    let indexer, actionsCtx;

    function makeDispenser(overrides) {
        return {
            ACTION_INDEX: 50,
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK: 'TEST',
            GIVE_REMAINING: '200',
            GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        indexer.util.resetLists();
        indexer.indexerDb.getSweepDestination.resolves(null);
        indexer.indexerDb.getDispenserCanceller.resolves(null);
    });

    // Returns the [credits, debits, escrows] the handler handed to the ledger writer.
    async function runSettlement(Handler, dispenser, data) {
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const capture = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
        await new Handler(actionsCtx).parse(null, data, null);
        assert.ok(capture.calledOnce, 'the ledger writer must still run on every settlement');
        return { credits: capture.getCall(0).args[2], escrows: capture.getCall(0).args[4] };
    }

    const closeData = () => createBaseData({
        ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'cancelled' });
    const expireData = () => createBaseData({
        ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });

    describe('a settled dispenser is never refunded twice', function () {

        SETTLED_STATUSES.forEach(function (status) {
            it('DISPENSER_CLOSE pushes no escrow/credit pair when the dispenser already settled as "' + status + '"', async function () {
                const r = await runSettlement(Dispenser_Close, makeDispenser({ DISPENSER_STATUS: status }), closeData());
                assert.deepStrictEqual(r.escrows, [], 'a re-settlement must move no escrow');
                assert.deepStrictEqual(r.credits, [], 'a re-settlement must credit nobody');
            });

            it('DISPENSER_EXPIRE pushes no escrow/credit pair when the dispenser already settled as "' + status + '"', async function () {
                const r = await runSettlement(Dispenser_Expire, makeDispenser({ DISPENSER_STATUS: status }), expireData());
                assert.deepStrictEqual(r.escrows, [], 'a re-settlement must move no escrow');
                assert.deepStrictEqual(r.credits, [], 'a re-settlement must credit nobody');
            });
        });
    });

    describe('every live first settlement still refunds in full', function () {

        LIVE_STATUSES.forEach(function (status) {
            it('DISPENSER_CLOSE still refunds GIVE_REMAINING from a "' + status + '" dispenser', async function () {
                const r = await runSettlement(Dispenser_Close, makeDispenser({ DISPENSER_STATUS: status }), closeData());
                assert.strictEqual(r.escrows.length, 1, 'the first refund must still move escrow');
                assert.strictEqual(String(r.escrows[0][1]), '-200');
                assert.strictEqual(String(r.credits[0][1]), '200');
            });
        });

        it('DISPENSER_EXPIRE still refunds GIVE_REMAINING from an "open" dispenser', async function () {
            const r = await runSettlement(Dispenser_Expire, makeDispenser({ DISPENSER_STATUS: 'open' }), expireData());
            assert.strictEqual(r.escrows.length, 1);
            assert.strictEqual(String(r.escrows[0][1]), '-200');
            assert.strictEqual(String(r.credits[0][1]), '200');
        });

        it('an unrecognized status still refunds: the guard fails OPEN, never onto a user\'s escrow', async function () {
            // The predicate names terminal states, not live ones, precisely so a status
            // it has not heard of is refunded rather than stranded. A future settlement
            // status must be added to util.isDispenserSettled; this asserts the direction
            // of the failure if someone forgets.
            const r = await runSettlement(Dispenser_Close, makeDispenser({ DISPENSER_STATUS: 'some_future_state' }), closeData());
            assert.strictEqual(r.escrows.length, 1, 'an unknown status must not suppress the refund');
        });
    });

    describe('util.isDispenserSettled', function () {

        it('classifies every status a settlement handler writes as settled', function () {
            for (const s of SETTLED_STATUSES)
                assert.strictEqual(indexer.util.isDispenserSettled(s), true, s + ' must count as settled');
        });

        it('classifies every live status as not settled', function () {
            for (const s of LIVE_STATUSES)
                assert.strictEqual(indexer.util.isDispenserSettled(s), false, s + ' must NOT count as settled');
        });

        it('a missing status is not settled (getDispenserInfo always supplies one; fail open anyway)', function () {
            assert.strictEqual(indexer.util.isDispenserSettled(undefined), false);
            assert.strictEqual(indexer.util.isDispenserSettled(null), false);
        });
    });
});
