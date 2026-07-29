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
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'SEND', FORMAT: 0 }, overrides));
}

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2       = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

// A tokenInfo with TICK_ID = 1 so hasBalance checks work
function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK:     'TEST',
        TICK_ID:  1,
        DECIMALS: 0,
    }, overrides));
}

function makeBalances(tickId, amount) {
    return { [tickId]: amount };
}

describe('Send handler @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);

        const token = makeToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        // Sufficient balance: 1000 of TICK_ID=1
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
        // Dispenser integration: no matching dispensers
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('format 0: single send', function () {

        it('valid single send → STATUS valid, createSend called', async function () {
            // params after ACTION stripped: [VERSION, TICK, AMOUNT, DESTINATION, MEMO]
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createSend.calledOnce, 'createSend should be called');
        });

        it('valid send → mapper.createMappings called', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('valid send → updateBalances called', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('valid send → processDispenserSends invoked', async function () {
            const dispSpy = sinon.spy(indexer.util, 'processDispenserSends');

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(dispSpy.calledOnce, 'processDispenserSends should be called after sends');
        });
    });

    describe('VERSION / FORMAT validation', function () {

        it('unknown format version → invalid', async function () {
            const params = ['99', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 99, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: null, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, 'invalid: pre-existing');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('TICK validations', function () {

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('createSend still called even when TICK unknown', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            // createSend is always called to record the attempt
            assert.ok(indexer.indexerDb.createSend.calledOnce);
        });
    });

    describe('AMOUNT validations', function () {

        it('insufficient balance → invalid', async function () {
            // Only 50 tokens in balance, trying to send 100
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 50));

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('AMOUNT with wrong decimal format (too many decimals for token) → invalid', async function () {
            // Token has 0 decimals: fractional amount invalid
            const params = ['0', 'TEST', '1.5', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid AMOUNT respecting token decimals → valid', async function () {
            const token = makeToken({ DECIMALS: 8 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '1.50000000', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('DESTINATION validations', function () {

        it('invalid DESTINATION address → invalid', async function () {
            const params = ['0', 'TEST', '100', 'not-a-valid-address', ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid DESTINATION address → valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('MEMO validations', function () {

        it('MEMO with pipe → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'bad|memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO with semicolon → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'bad;memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO over max length → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(251)];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO at max length (250) → valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(250)];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('MEMO required by destination preferences but missing → invalid', async function () {
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 1 });

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO required and provided → valid', async function () {
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 1 });

            const params = ['0', 'TEST', '100', DESTINATION, 'here is my memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('address and tick sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            // First isActionAllowed call is SOURCE check
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(false)  // SOURCE sleeping
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE ok
                .onSecondCall().resolves(false)  // TICK sleeping
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('SOURCE not authorized by token allow/block list → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping check
                .onSecondCall().resolves(true)   // TICK sleeping check
                .onThirdCall().resolves(false)   // SOURCE authorization check
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('DESTINATION not authorized → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping
                .onSecondCall().resolves(true)   // TICK sleeping
                .onThirdCall().resolves(true)    // SOURCE authorization
                .onCall(3).resolves(false)        // DESTINATION authorization
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('format 1: multi-send brief', function () {

        it('valid multi-send brief (two destinations) → two createSend calls', async function () {
            // Format 1: VERSION|TICK|AMOUNT|DEST|AMOUNT|DEST|MEMO
            const params = ['1', 'TEST', '50', DESTINATION, '30', DEST2, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // Both sends should produce records; last status is what's set on data
            assert.ok(indexer.indexerDb.createSend.calledTwice, 'createSend should be called twice');
        });

        it('insufficient balance for total multi-send → second send invalid', async function () {
            // Only 60 tokens; first send 50 leaves 10; second send of 30 fails
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 60));

            const params = ['1', 'TEST', '50', DESTINATION, '30', DEST2, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // At least one send was invalid
            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('format 2: multi-send full', function () {

        it('valid multi-send full with two different ticks → two createSend calls', async function () {
            const token2 = makeToken({ TICK: 'OTHER', TICK_ID: 2, DECIMALS: 0 });

            // Return tokens by tick name
            indexer.indexerDb.getTokenInfo
                .withArgs('TEST', sinon.match.any, sinon.match.any).resolves(makeToken())
                .withArgs('OTHER', sinon.match.any, sinon.match.any).resolves(token2);

            // Balance for both tokens
            indexer.indexerDb.getAddressBalances.resolves({ 1: 1000, 2: 1000 });

            // Format 2: VERSION|TICK|AMOUNT|DEST|TICK|AMOUNT|DEST|MEMO
            const params = ['2', 'TEST', '50', DESTINATION, 'OTHER', '30', DEST2, ''];
            const data   = makeData({ FORMAT: 2, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSend.calledTwice);
        });
    });

    describe('format 3: multi-send with memos', function () {

        it('valid format 3 with two sends and separate memos → two createSend calls', async function () {
            // Format 3: VERSION|TICK|AMOUNT|DEST|MEMO|TICK|AMOUNT|DEST|MEMO
            const params = ['3', 'TEST', '50', DESTINATION, 'memo1', 'TEST', '30', DEST2, 'memo2'];
            const data   = makeData({ FORMAT: 3, SOURCE });

            await handler.parse(params, data, null);

            // The two sends to different destinations should result in two records
            assert.ok(indexer.indexerDb.createSend.calledTwice);
        });
    });

    describe('multi-send consolidation', function () {

        it('same TICK+DESTINATION across multiple sends are consolidated', async function () {
            // Format 1 with two entries going to the same destination
            // They should be consolidated into a single send
            const params = ['1', 'TEST', '50', DESTINATION, '30', DESTINATION, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // After consolidation, only ONE createSend call for the merged 80-token send
            assert.ok(indexer.indexerDb.createSend.calledOnce, 'consolidated sends should produce one record');
        });

        it('consolidated amount is sum of individual amounts', async function () {
            const params = ['1', 'TEST', '50', DESTINATION, '30', DESTINATION, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            const callArg = indexer.indexerDb.createSend.firstCall.args[0];
            // The util merges them so AMOUNT should reflect the combined total
            const util   = indexer.util;
            assert.strictEqual(util.bcformat(callArg.AMOUNT, 0), '80');
        });
    });

    describe('createSend is always called', function () {

        it('createSend is called even on invalid send', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null); // TICK unknown

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createSend.calledOnce);
        });
    });
});

/*********************************************************************
 * PC-29 /  §5.4: the key-handoff requirement is CONDITIONAL.
 *
 * Before this, ANY gated FILE on a tick made EVERY send of that tick require a
 * paired MESSAGE handoff. Now a pack only compels one when the recipient will
 * actually end up able to unlock it, which is what makes a threshold mean
 * anything at all.
 *
 * The comparison is POST-SEND balance (what they hold + everything this action
 * sends them), not the amount sent. Both halves matter: a recipient who already
 * holds enough crosses on any transfer, and one who holds nothing may not cross
 * even on a large one.
 ********************************************************************/
describe('Send handler: conditional gated handoff (PC-29) @regression @tier1', function () {

    let indexer, actionsCtx, handler;

    const PUB  = 'mpub1111111111111111111111111111111';
    const HASH = 'a'.repeat(64);

    // A MESSAGE v2 sibling addressed to `dest` (the handoff carrier).
    const handoffTo = (dest) => ({ action: 'MESSAGE', params: ['2', 'BTC', dest, 'ciphertext'] });

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        // SOURCE holds plenty; destination balances are set per test.
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
    });

    afterEach(function () { sinon.restore(); });

    // Give the destination a starting balance while keeping SOURCE funded.
    function withDestBalance(destHeld, dest = DESTINATION) {
        indexer.indexerDb.getAddressBalances.callsFake(async (addr) =>
            (addr === dest ? makeBalances(1, destHeld) : makeBalances(1, 1000)));
    }

    async function statusFor(params, { packs, siblings, format } = {}) {
        indexer.indexerDb.getGatedPackThresholds.resolves(packs || []);
        const data = makeData({ SOURCE, SIBLING_ACTIONS: siblings || [],
                                ...(format !== undefined ? { FORMAT: format } : {}) });
        await handler.parse(params, data, null);
        return data['STATUS'];
    }

    const NEEDS_HANDOFF = 'invalid: gated token transfer requires key handoff message';
    const single = (amount, dest = DESTINATION) => ['0', 'TEST', String(amount), dest, ''];

    it('BELOW the threshold: a plain SEND with no handoff is valid', async function () {
        withDestBalance(0);
        const status = await statusFor(single(50), { packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] });
        assert.strictEqual(status, 'valid', 'the recipient cannot unlock, so no key is owed');
    });

    it('AT the threshold: the handoff becomes required', async function () {
        withDestBalance(0);
        const packs = [{ publisher: PUB, keyHash: HASH, threshold: '100' }];
        assert.strictEqual(await statusFor(single(100), { packs }), NEEDS_HANDOFF);
        assert.strictEqual(await statusFor(single(100), { packs, siblings: [handoffTo(DESTINATION)] }), 'valid');
    });

    it('counts the recipient\'s EXISTING balance, not just the amount sent', async function () {
        // Holds 99, receives 1 -> 100. A rule that only looked at the amount would
        // hand over the key for free here, or never require it at all.
        withDestBalance(99);
        assert.strictEqual(
            await statusFor(single(1), { packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] }),
            NEEDS_HANDOFF);
    });

    it('an UNCONDITIONAL pack (no threshold) always requires the handoff', async function () {
        withDestBalance(0);
        assert.strictEqual(
            await statusFor(single(1), { packs: [{ publisher: PUB, keyHash: HASH, threshold: null }] }),
            NEEDS_HANDOFF, 'a pack with no threshold is readable by any holder');
    });

    it('ANY required pack compels the handoff, even when others are not', async function () {
        withDestBalance(0);
        const packs = [
            { publisher: PUB, keyHash: HASH,         threshold: '1000' },  // not reached
            { publisher: PUB, keyHash: 'b'.repeat(64), threshold: '10' },   // reached
        ];
        assert.strictEqual(await statusFor(single(50), { packs }), NEEDS_HANDOFF);
    });

    // ── Rule 3's three pinned vectors ───────────────────────────────────────
    it('vector 1, MULTI-LEG same destination: legs are totalled, not judged alone', async function () {
        // 60 + 60 against a threshold of 100. Judged per leg, neither reaches it and
        // the recipient gets 120 with no key handoff: the split bypass. Legs are
        // consolidated by (DESTINATION, TICK) before this check, so the total is what
        // is compared. This vector exists so a future de-consolidation cannot silently
        // reopen the hole.
        withDestBalance(0);
        // Format 1 is VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO:
        // one tick, then repeating (amount, destination) pairs.
        const params = ['1', 'TEST', '60', DESTINATION, '60', DESTINATION, ''];
        assert.strictEqual(
            await statusFor(params, { format: 1, packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] }),
            NEEDS_HANDOFF, 'two legs of 60 must total 120 and cross the threshold of 100');
    });

    it('vector 2, TWO ACTIONS in one transaction: the snapshot base compounds', async function () {
        // The destination-balance snapshot is scoped by (BLOCK_INDEX, ACTION_INDEX),
        // so a second SEND action in the same transaction sees the first one's effect.
        // Modelled here by the balance the second action reads.
        withDestBalance(60);   // what the first action already delivered
        assert.strictEqual(
            await statusFor(single(60), { packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] }),
            NEEDS_HANDOFF, 'validating against pre-transaction state would reopen the split one level up');
    });

    it('vector 3, SELF-SEND: applied literally, and the self-addressed MESSAGE satisfies it', async function () {
        // Deliberately NOT special-cased. The overcount (balance already counted, then
        // counted again as incoming) is accepted for determinism.
        withDestBalance(100, SOURCE);
        assert.strictEqual(
            await statusFor(single(1, SOURCE), { packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] }),
            NEEDS_HANDOFF);
        assert.strictEqual(
            await statusFor(single(1, SOURCE), {
                packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }],
                siblings: [handoffTo(SOURCE)]
            }), 'valid');
    });

    it('an ungated tick reads no DESTINATION balance', async function () {
        // Asserted on the ARGUMENTS, not on a call count: SEND legitimately reads
        // balances more than once (all-ticks plus a GAS-only read), so a count is
        // both brittle and does not state the property. What matters is that the
        // destination is never one of the addresses read.
        indexer.indexerDb.getGatedPackThresholds.resolves([]);
        const data = makeData({ SOURCE, SIBLING_ACTIONS: [] });
        await handler.parse(single(10), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const addressesRead = indexer.indexerDb.getAddressBalances.getCalls().map(c => c.args[0]);
        assert.ok(!addressesRead.includes(DESTINATION),
            'an ungated SEND must not pay for a destination-balance read; read: ' + JSON.stringify(addressesRead));
    });

    it('a GATED tick does read the destination balance', async function () {
        // The negative above is only meaningful next to this positive: it proves the
        // read is skipped for a reason, not simply never wired up.
        withDestBalance(0);
        await statusFor(single(10), { packs: [{ publisher: PUB, keyHash: HASH, threshold: '100' }] });
        const addressesRead = indexer.indexerDb.getAddressBalances.getCalls().map(c => c.args[0]);
        assert.ok(addressesRead.includes(DESTINATION), 'the threshold cannot be evaluated without it');
    });
});
