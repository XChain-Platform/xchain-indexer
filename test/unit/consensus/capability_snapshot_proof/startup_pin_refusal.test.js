/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const {
    startupPinRefusal,
} = require('../../../../src/consensus/capability_snapshot_proof/startup_pin_refusal.js');

const TESTNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';
const MAINNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_MAINNET';

function pinned(pubkey = 'a'.repeat(64)){
    return JSON.stringify([{ pubkey, weight: '1', source: 'source-1' }]);
}

function armed(network = 'testnet'){
    return { network, resolvesFromMirror: true, gateArmed: true };
}

function decide(opts, values){
    return startupPinRefusal(opts, (name) => values[name]);
}

function assertRefused(actual, pin, detail){
    assert.strictEqual(typeof actual, 'string');
    assert.match(actual, new RegExp(pin));
    assert.match(actual, new RegExp(pin + '_NEXT'));
    if(detail) assert.match(actual, detail);
}

describe('capability snapshot proof startup pin refusal', function () {
    it('refuses armed testnet and mainnet startup without a pin', function () {
        assertRefused(decide(armed('testnet'), {}), TESTNET_PIN);
        assertRefused(decide(armed('mainnet'), {}), MAINNET_PIN);
    });

    it('refuses invalid and empty-array static pins with their parser errors', function () {
        assertRefused(decide(armed(), { [TESTNET_PIN]: 'not json' }), TESTNET_PIN, /not valid JSON/);
        assertRefused(decide(armed(), { [TESTNET_PIN]: '[]' }), TESTNET_PIN, /empty array/);
    });

    it('allows startup with a valid static pin', function () {
        assert.strictEqual(decide(armed(), { [TESTNET_PIN]: pinned() }), null);
    });

    it('allows a valid _NEXT pin with a decimal safe integer _FROM', function () {
        assert.strictEqual(decide(armed(), {
            [TESTNET_PIN + '_NEXT']: pinned('b'.repeat(64)),
            [TESTNET_PIN + '_FROM']: '100',
        }), null);
    });

    it('refuses a valid _NEXT pin with an invalid _FROM', function () {
        for(const from of ['x', '1e3', '-1', '9007199254740992']){
            assertRefused(decide(armed(), {
                [TESTNET_PIN + '_NEXT']: pinned('b'.repeat(64)),
                [TESTNET_PIN + '_FROM']: from,
            }), TESTNET_PIN, /_FROM/);
        }
    });

    it('allows an unarmed chain and one that resolves nothing from the mirror', function () {
        assert.strictEqual(decide({ network: 'testnet', resolvesFromMirror: true, gateArmed: false }, {}), null);
        assert.strictEqual(decide({ network: 'testnet', resolvesFromMirror: false, gateArmed: true }, {}), null);
    });

    it('allows regtest and missing options', function () {
        assert.strictEqual(decide(armed('regtest'), {}), null);
        assert.strictEqual(decide(null, {}), null);
    });

    it('uses the call-time process environment reader by default', function () {
        const saved = process.env[TESTNET_PIN];
        try {
            process.env[TESTNET_PIN] = pinned('c'.repeat(64));
            assert.strictEqual(startupPinRefusal(armed()), null);
        } finally {
            if(saved === undefined) delete process.env[TESTNET_PIN];
            else process.env[TESTNET_PIN] = saved;
        }
    });

    it('turns environment reader failures into refusal messages', function () {
        let actual;
        assert.doesNotThrow(() => {
            actual = startupPinRefusal(armed(), () => { throw new Error('reader failed'); });
        });
        assertRefused(actual, TESTNET_PIN, /reader failed/);
    });
});
