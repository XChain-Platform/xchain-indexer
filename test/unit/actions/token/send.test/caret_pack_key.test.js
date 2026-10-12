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
// Send handler: a caret-id SEND of a gated token looks up the pack by the resolved tick name.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../../fixtures/mocks');
const Send = require('../../../../../src/actions/send/index.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');
const {
    SOURCE, DESTINATION, makeActionsCtx, makeData, makeToken, makeBalances,
} = require('./helpers/send_harness.js');

const ROW   = 'send_caret_pack_key_activation.SEND_CARET_PACK_KEY_ACTIVATION';
const PACKS = [{ publisher: 'mpub1111111111111111111111111111111', keyHash: 'a'.repeat(64), threshold: null }];
const NEEDS_HANDOFF = 'invalid: gated token transfer requires key handoff message';

let indexer, handler;

async function sendStatus(tick, siblings) {
    const data = makeData({ SOURCE, SIBLING_ACTIONS: siblings || [] });
    await handler.parse(['0', tick, '10', DESTINATION, ''], data, null);
    return data['STATUS'];
}

describe('Send handler: caret-id pack keying @regression @tier1', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        const actionsCtx = makeActionsCtx(indexer);
        handler = new Send(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        indexer.indexerDb.getGatedPackThresholds.callsFake(async (t) => (t === 'TEST' ? PACKS : []));
        indexer.indexerDb.getAddressBalances.callsFake(async (addr) =>
            (addr === DESTINATION ? makeBalances(1, 0) : makeBalances(1, 1000)));
    });

    afterEach(function () { sinon.restore(); });

    it('the new row is unarmed on mainnet and armed on testnet and regtest', function () {
        assert.strictEqual(gateRegistry.activeAt(ROW, 'mainnet', null, null, 1e12), false);
        assert.strictEqual(gateRegistry.activeAt(ROW, 'testnet', null, null, 1), true);
        assert.strictEqual(gateRegistry.activeAt(ROW, 'regtest', null, null, 1), true);
    });

    it('ACTIVE: a caret-id SEND of a gated token is refused without the key handoff', async function () {
        assert.strictEqual(await sendStatus('^12'), NEEDS_HANDOFF);
    });

    it('ACTIVE: a named SEND of the same token is refused the same way', async function () {
        assert.strictEqual(await sendStatus('TEST'), NEEDS_HANDOFF);
    });

    it('ACTIVE: a caret-id SEND with the handoff message is accepted', async function () {
        const msg = { action: 'MESSAGE', params: ['2', 'BTC', DESTINATION, 'ciphertext'] };
        assert.strictEqual(await sendStatus('^12', [msg]), 'valid');
    });

    it('INERT: the legacy lookup by the caret spelling finds no pack and the SEND passes', async function () {
        const stub = stubActiveAt(sinon, ROW, false);
        try { assert.strictEqual(await sendStatus('^12'), 'valid'); }
        finally { stub.restore(); }
    });
});
