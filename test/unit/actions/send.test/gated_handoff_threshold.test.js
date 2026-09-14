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
//
// Send handler: the conditional gated key handoff (PC-29), judged on the
// recipient's post-send balance against each pack threshold.
// Part of the Send suite; see ../send.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../fixtures/mocks');

const Send = require('../../../../src/actions/send/index.js');
const {
    SOURCE, DESTINATION, makeActionsCtx, makeData, makeToken, makeBalances,
} = require('./helpers/send_harness.js');

/*********************************************************************
 * The key-handoff requirement is CONDITIONAL.
 *
 * An unconditional rule, where ANY gated FILE on a tick makes EVERY send of that tick require a
 * paired MESSAGE handoff, is too broad. A pack only compels one when the recipient will
 * actually end up able to unlock it, which is what makes a threshold mean
 * anything at all.
 *
 * The comparison is POST-SEND balance (what they hold + everything this action
 * sends them), not the amount sent. Both halves matter: a recipient who already
 * holds enough crosses on any transfer, and one who holds nothing may not cross
 * even on a large one.
 ********************************************************************/

let indexer, actionsCtx, handler;

const PUB  = 'mpub1111111111111111111111111111111';
const HASH = 'a'.repeat(64);

// A MESSAGE v2 sibling addressed to `dest` (the handoff carrier).
const handoffTo = (dest) => ({ action: 'MESSAGE', params: ['2', 'BTC', dest, 'ciphertext'] });

// The suite's hooks, installed in each describe below: a fresh handler over a
// known token, an open address and a funded SOURCE before every test, every
// sinon stub restored after it.
function useThresholdHarness() {
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
}

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

describe('Send handler: conditional gated handoff (PC-29) @regression @tier1', function () {
    useThresholdHarness();

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
});

describe('Send handler: conditional gated handoff (PC-29) @regression @tier1', function () {
    useThresholdHarness();

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
});

describe('Send handler: conditional gated handoff (PC-29) @regression @tier1', function () {
    useThresholdHarness();

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
