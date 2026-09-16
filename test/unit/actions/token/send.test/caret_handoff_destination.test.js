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
// Send handler: the gated handoff matched by ADDRESS when its MESSAGE
// destination arrives caret-compacted as `^<id>`, above and below the flag day.
// Part of the Send suite; see ../send.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../../fixtures/mocks');

const Send = require('../../../../../src/actions/send/index.js');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');
const HANDOFF_ROW = 'gated_handoff_ref_activation.GATED_HANDOFF_REF_ACTIVATION';
const {
    SOURCE, DESTINATION, DEST2, makeActionsCtx, makeData, makeToken, makeBalances,
} = require('./helpers/send_harness.js');

let indexer, actionsCtx;

const PUB   = 'mpub1111111111111111111111111111111';
const HASH  = 'a'.repeat(64);
const REF   = '^57';
const PACKS = [{ publisher: PUB, keyHash: HASH, threshold: null }];

const NEEDS_HANDOFF = 'invalid: gated token transfer requires key handoff message';
const messageTo = (dest) => ({ action: 'MESSAGE', params: ['2', 'BTC', dest, 'ciphertext'] });

// Every network is genesis-active for this gate now: regtest and testnet since it
// landed, mainnet since the 2026-09-09 ruling (mainnet history is ISSUE and ANCHOR
// only, so 0 SEND, measured 2026-09-09, leaves the resolved compare identity over
// it). The network therefore no longer selects the era on its own.
function handlerOn(network) {
    return new Send(Object.assign({}, actionsCtx, {
        config: Object.assign({}, indexer.config, { NETWORK: network })
    }));
}

// The pre-flag-day era is reached by answering THIS key inert on a mainnet venue for
// the duration of the call (the registry row is frozen, so the read is stubbed).
// Answering only this key is deliberate: the venue keeps every other mainnet gate
// send.js reads (consolidation_leg_amount) at the value the fleet runs, so the legacy
// arm being compared against is the real one.
async function belowFlag(fn) {
    const stub = stubActiveAt(sinon, HANDOFF_ROW, false);
    try { return await fn(); }
    finally { stub.restore(); }
}

// How the indexer's resolver answers a `^<id>`: to `addr`, or refused.
function refResolves(addr, rejected) {
    indexer.indexerDb.resolveAddressRefChecked.callsFake(async (v) => (
        String(v).substring(0, 1) === '^'
            ? { value: (rejected ? v : addr), rejected: !!rejected }
            : { value: v, rejected: false }));
}

async function statusFor(handler, siblings) {
    const data = makeData({ SOURCE, SIBLING_ACTIONS: siblings });
    await handler.parse(['0', 'TEST', '10', DESTINATION, ''], data, null);
    return data['STATUS'];
}

/*********************************************************************
 * The gated handoff is matched by ADDRESS, not by wire spelling.
 *
 * BATCH siblings carry raw wire parameters, and the SDK compacts a MESSAGE
 * DESTINATION to `^<id>` for any already-indexed recipient, so a byte compare
 * misses the ordinary wallet-composed handoff and rejects the SEND while the
 * rest of the batch commits. Above the flag day a caret spelling is resolved
 * before the compare; below it the byte compare runs untouched so historical
 * replay stays byte-identical. Both sides are driven here. Every network is armed
 * at genesis since the 2026-09-09 ruling, so the below-flag cases reach the legacy
 * era by pinning the gate's own key inert rather than by naming a network.
 ********************************************************************/
describe('Send handler: caret-compacted handoff destination @regression @tier1', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        indexer.indexerDb.getGatedPackThresholds.resolves(PACKS);
        // SOURCE funded, destination empty (the pack is unconditional, so the
        // handoff is required either way).
        indexer.indexerDb.getAddressBalances.callsFake(async (addr) =>
            (addr === DESTINATION ? makeBalances(1, 0) : makeBalances(1, 1000)));
    });

    afterEach(function () { sinon.restore(); });

    it('ARMED: a `^<id>` handoff resolving to the destination is accepted', async function () {
        refResolves(DESTINATION);
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(REF)]), 'valid',
            'the rule is about the address, and this MESSAGE is addressed to the destination');
    });

    it('UNARMED (key pinned inert): the same transaction is still rejected below the flag day', async function () {
        refResolves(DESTINATION);
        assert.strictEqual(
            await belowFlag(() => statusFor(handlerOn('mainnet'), [messageTo(REF)])), NEEDS_HANDOFF,
            'below the threshold the byte compare runs untouched, so replay stays byte-identical');
        assert.strictEqual(indexer.indexerDb.resolveAddressRefChecked.callCount, 0,
            'an unarmed chain must not even issue the resolution read');
    });

    it('ARMED (mainnet, shipped map): the same transaction is accepted since the 2026-09-09 ruling', async function () {
        // The other half of the pair above, driven on the shipped key: the exact wire the
        // pinned-inert arm rejects is now accepted on mainnet, and the resolution read the
        // inert arm must never issue is issued here.
        refResolves(DESTINATION);
        assert.strictEqual(await statusFor(handlerOn('mainnet'), [messageTo(REF)]), 'valid',
            'mainnet is armed at genesis, so a caret-spelled handoff resolves before the compare');
        assert.ok(indexer.indexerDb.resolveAddressRefChecked.callCount > 0,
            'the armed chain must issue the resolution read');
    });

    it('ARMED: a `^<id>` resolving to a DIFFERENT address is still rejected', async function () {
        refResolves(DEST2);
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(REF)]), NEEDS_HANDOFF,
            'resolution must not turn the gate into one that matches anything');
    });

    it('ARMED: a REFUSED reference fails closed', async function () {
        refResolves(DESTINATION, true);
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(REF)]), NEEDS_HANDOFF);
    });
});

describe('Send handler: caret-compacted handoff destination @regression @tier1', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        indexer.indexerDb.getGatedPackThresholds.resolves(PACKS);
        // SOURCE funded, destination empty (the pack is unconditional, so the
        // handoff is required either way).
        indexer.indexerDb.getAddressBalances.callsFake(async (addr) =>
            (addr === DESTINATION ? makeBalances(1, 0) : makeBalances(1, 1000)));
    });

    afterEach(function () { sinon.restore(); });

    it('ARMED: a dangling reference the resolver returns unchanged fails closed', async function () {
        // Below the caret-ref-strict flag day the resolver reports a malformed or
        // dangling reference only by leaving it caret-prefixed, with rejected false.
        indexer.indexerDb.resolveAddressRefChecked.callsFake(async (v) => ({ value: v, rejected: false }));
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(REF)]), NEEDS_HANDOFF,
            'a value still spelled `^...` after resolution matches nothing');
    });

    it('ARMED: a full-address handoff still passes, and pays for no resolution', async function () {
        refResolves(DESTINATION);
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(DESTINATION)]), 'valid');
        assert.strictEqual(indexer.indexerDb.resolveAddressRefChecked.callCount, 0,
            'resolution is caret-only; an ordinary handoff must cost no extra read');
    });

    it('ARMED: a full-address handoff to the WRONG address is still rejected', async function () {
        refResolves(DESTINATION);
        assert.strictEqual(await statusFor(handlerOn('regtest'), [messageTo(DEST2)]), NEEDS_HANDOFF);
    });

    it('UNARMED (key pinned inert): a full-address handoff still passes', async function () {
        assert.strictEqual(
            await belowFlag(() => statusFor(handlerOn('mainnet'), [messageTo(DESTINATION)])), 'valid',
            'the legacy path is unchanged for every transaction that already worked');
    });

    it('ARMED: a v1 MESSAGE carrying the destination does not satisfy the gate', async function () {
        refResolves(DESTINATION);
        const v1 = { action: 'MESSAGE', params: ['1', 'BTC', REF, 'ciphertext'] };
        assert.strictEqual(await statusFor(handlerOn('regtest'), [v1]), NEEDS_HANDOFF,
            'the version check must survive the resolution branch');
    });
});
