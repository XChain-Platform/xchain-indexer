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

// Regression coverage for uuid:e1deb0d9 - SEND double-counting a controller-bound GAS
// token balance. When the sent tick IS the gas tick, `balances` (all ticks) and
// `gasBalances` (GAS only) used to be two independent in-memory snapshots of the exact
// same underlying balance: the send-amount check/debit ran against `balances` while the
// controller-guard fee reservation/debit ran against `gasBalances`, so a single GAS
// balance could pass both checks independently and be debited AMOUNT + guardFee, driving
// the ledger negative. The fix (src/actions/send.js) reserves/debits the guard fee against
// the SAME `balances` snapshot as AMOUNT whenever the send tick equals the gas tick,
// mirroring the airdrop/dividend/sweep pattern.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Send = require('../../../src/actions/send.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true), // CONTROLLER_GUARD active
        },
        // The guard's VM run; only reached once the ceiling-reservation hasBalance check
        // (the thing under test) has already passed.
        actionExecute: {
            runControllerGuard: sinon.stub().resolves({ allow: true, gasBilled: 100000, payoutLegs: null }),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'SEND', FORMAT: 0 }, overrides));
}

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

describe('Send handler - GAS guard-fee double-count regression @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);

        // The guard-fee reservation reads the gas schedule off the DB handle
        // (resolveGuardGasCeiling(db.config)); the mock DB carries no config,
        // so wire the real test config onto it.
        indexer.indexerDb.config = indexer.config;
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        // Bind a `transfer`-class controller to the token so maybeRunControllerGuard runs
        // (rather than bailing out early as a no-op).
        indexer.indexerDb.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
        indexer.indexerDb.getTickerId.resolves(1);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('GAS bound to a transfer controller: sending exactly the GAS balance is rejected, not driven negative', async function () {
        const GAS = actionsCtx.config['GAS'];

        // The sent token IS the GAS token (TICK_ID=1), bound to the controller above.
        const gasToken = createTokenInfo({ TICK: GAS, TICK_ID: 1, DECIMALS: 8 });
        indexer.indexerDb.getTokenInfo.resolves(gasToken);

        // Sender holds EXACTLY 10 GAS, and sends all 10. The regtest GAS_SCHEDULE ceiling
        // (VM_GUARD_GAS_CEILING * GAS_PRICE) is a nonzero guard fee reserved on top of AMOUNT,
        // so 10 + guardFee must be covered by a single 10-GAS balance - it can't be.
        indexer.indexerDb.getAddressBalances.resolves({ 1: '10' });

        const params = ['0', GAS, '10', DESTINATION, ''];
        const data   = makeData({ FORMAT: 0, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(String(data.STATUS).startsWith('invalid'), 'expected the send to be rejected, got: ' + data.STATUS);
        assert.ok(String(data.STATUS).includes('insufficient funds'), 'expected an insufficient-funds rejection, got: ' + data.STATUS);

        // The send must never have been recorded as valid, so no GAS debit for AMOUNT or
        // guardFee should have been queued into the ledger.
        assert.ok(indexer.indexerDb.createSend.calledOnce);
    });

    it('GAS bound to a transfer controller: balance covering AMOUNT + guardFee together is accepted', async function () {
        const GAS = actionsCtx.config['GAS'];

        const gasToken = createTokenInfo({ TICK: GAS, TICK_ID: 1, DECIMALS: 8 });
        indexer.indexerDb.getTokenInfo.resolves(gasToken);

        // Enough GAS to cover AMOUNT (10) plus the guard-fee ceiling (200000 * 0.00001 = 2).
        indexer.indexerDb.getAddressBalances.resolves({ 1: '15' });

        const params = ['0', GAS, '10', DESTINATION, ''];
        const data   = makeData({ FORMAT: 0, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid');
    });

    it('send tick different from gas tick: independent balances/guard-fee snapshots are unaffected', async function () {
        const GAS = actionsCtx.config['GAS'];

        const sendToken = createTokenInfo({ TICK: 'TEST', TICK_ID: 2, DECIMALS: 0 });
        const gasToken  = createTokenInfo({ TICK: GAS, TICK_ID: 1, DECIMALS: 8 });

        indexer.indexerDb.getTokenInfo
            .withArgs('TEST', sinon.match.any, sinon.match.any).resolves(sendToken)
            .withArgs(GAS, sinon.match.any, sinon.match.any).resolves(gasToken);
        indexer.indexerDb.getTickerId.withArgs('TEST').resolves(2);

        // Plenty of TEST for the send AMOUNT, and separately plenty of GAS for the guard fee -
        // this is the case the two-snapshot design was originally meant for.
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '100' });

        const params = ['0', 'TEST', '100', DESTINATION, ''];
        const data   = makeData({ FORMAT: 0, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid');
    });
});
