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
// CROSS_SETTLE cross-chain royalty (CROSS_CHAIN_ROYALTY): counterparty legs split
// the released proceeds, stripped legs fail verification, an undecodable leg
// fails closed, and the legacy full credit below the flag-day. Part of the
// Cross_Settle suite; see ../cross_settle.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { makeMatch, signMatch, snapFor, makeData, useCrossSettleHarness } = require('./helpers/cross_settle_harness.js');

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// Regtest p2pkh: LTC→BTC regtest re-encode is the identity (shared 0x6f prefix),
// so the leg credit lands on this exact address.
const LEG_TO = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const LEGS   = JSON.stringify([{ to: LEG_TO, bps: 2500 }]);

function creditsSeen() {
    return indexer.indexerDb.createCredit.getCalls().map(c => c.args); // [action_index, tick, amount, address]
}

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    describe('cross-chain royalty at settlement (CROSS_CHAIN_ROYALTY)', function () {
        it('applies the counterparty legs to the released proceeds (seller remainder + leg credit)', async function () {
            // BTC is leg a; its escrow releases to b's payout, so b's legs (b_payout_legs,
            // in b_chain=LTC encoding) split these proceeds: 10 AAA → 8 remainder + 2 leg (2500 bps).
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 2, 'remainder + one leg credit');
            const remainder = credits.find(c => c[3] === match.b_payout_addr);
            const legCredit = credits.find(c => c[3] === LEG_TO);
            assert.ok(remainder && legCredit);
            assert.strictEqual(Number(remainder[2]), 8);
            assert.strictEqual(Number(legCredit[2]), 2);
            // Escrow release is unchanged (single full release; the split only shapes credits)
            assert.ok(indexer.indexerDb.createEscrow.calledOnce);
        });

        it('a match with STRIPPED legs no longer verifies against legs-bearing signatures', async function () {
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            match.b_payout_legs = null;   // hub-side tamper after signing
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    describe('cross-chain royalty at settlement (CROSS_CHAIN_ROYALTY)', function () {
        const ccr = require('../../../../src/cross_chain_royalty_activation.js');

        it('fail-closed: a leg that does not re-encode yields NO split (full proceeds credit)', async function () {
            // A segwit-looking leg claimed to be DOGE-encoded can never decode (DOGE has no
            // bech32 HRP), so the split is dropped and the seller keeps the full proceeds.
            const badLegs = JSON.stringify([{ to: 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul', bps: 2500 }]);
            const { match } = signMatch(makeMatch({ b_chain: 'DOGE', b_payout_legs: badLegs }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(Number(credits[0][2]), 10);
            assert.strictEqual(credits[0][3], match.b_payout_addr);
        });

        it('below the flag-day the split is not applied (legacy full credit)', async function () {
            const flagStub = sinon.stub(ccr, 'isCrossChainRoyaltyActive').returns(false);
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);   // legacy canonical (no legs bytes)
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            flagStub.restore();
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(Number(credits[0][2]), 10);
        });
    });

    describe('cross-chain royalty at settlement (CROSS_CHAIN_ROYALTY)', function () {
        it('applies the legs on an ORDER-leg partial fill too', async function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);
            const { match } = signMatch(makeMatch({ a_kind: 'order', b_kind: 'order', b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 2);
            assert.strictEqual(Number(credits.find(c => c[3] === LEG_TO)[2]), 2);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.calledOnce);
        });
    });
});
