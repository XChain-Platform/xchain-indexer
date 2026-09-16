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
// Attestation framework: the cross-chain relay legs, origin-side admission
// (ATTEST_RELAY_ORIGIN): an off-BTC v0 is admitted and stamped with its origin
// chain when the gate is on, rejected as before when it is off, and never
// stamped on the home chain.
//
// The suite title, what the relay tests protect in priority order, and the
// shared setup (./helpers/relay_fixture.js) are described in ../attest_relay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createBaseData } = require('../../../fixtures/mocks');

const { setupRelay } = require('./helpers/relay_fixture.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// ── 7. Origin-side admission relaxation (ATTEST_RELAY_ORIGIN) ────────────

// A minimal, otherwise-valid v0 emission on the origin chain.
// Each block below binds it to the running case's indexer as v0Emission(coin).
function v0EmissionOn(indexer, coin) {
    const txHash = 'a'.repeat(64);
    const preimage = txHash + ':' + 1 + ':' + '' + ':' + 5 + ':' + 0;
    const rid = crypto.createHash('sha256').update(preimage).digest('hex');
    const data = createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, BLOCK_INDEX: 3160000, TX_HASH: txHash,
        IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0, EMITTER_PATH: '',
        ROOT_ACTION_INDEX: 1, SOURCE: 'origin-addr'
    });
    indexer.config['COIN'] = coin;
    return { data, params: [0, rid, 'http_get', 'https://example.com', 'onResult', '[]', 1, 10] };
}

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, protocolGates;
    beforeEach(function () { ({ indexer, handler, protocolGates } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('origin-side v0 admission', function () {
        const v0Emission = (coin) => v0EmissionOn(indexer, coin);

        it('admits an off-BTC request and stamps its origin chain when the gate is on', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = true;
            const { data, params } = v0Emission('LTC');

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
            assert.strictEqual(data['ORIGIN_CHAIN'], 'LTC',
                'the origin stamp is the only marker the hub relay poll keys on');
            // the paired half. On an origin row "the origin chain's v0
            // action_index" is this row's own, and the pair is the relay identity the
            // BTC-side exactly-once guard keys on.
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], data['ACTION_INDEX']);
            assert.notStrictEqual(data['ORIGIN_ACTION_INDEX'], null);
        });

        it('leaves the admission rejection intact when the gate is off', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = false;
            stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', true);
            const { data, params } = v0Emission('LTC');

            await handler.parse(params, data, null);

            assert.match(data['STATUS'], /responsible set/);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            assert.strictEqual(data['ORIGIN_CHAIN'], null);
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], null,
                'both halves of the relay identity share one predicate: a rejected row carries neither');
        });
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, protocolGates;
    beforeEach(function () { ({ indexer, handler, protocolGates } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('origin-side v0 admission', function () {
        const v0Emission = (coin) => v0EmissionOn(indexer, coin);

        it('never stamps an origin on the home chain', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = true;
            const { data, params } = v0Emission('BTC');

            await handler.parse(params, data, null);

            assert.strictEqual(data['ORIGIN_CHAIN'], null,
                'a BTC request is serviced in place and must never look relay-eligible');
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], null);
        });
    });
});
