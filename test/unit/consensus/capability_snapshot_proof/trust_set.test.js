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
const { resolveTrustSet } = require('../../../../src/consensus/capability_snapshot_proof/trust_set.js');

const TESTNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';
const MAINNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_MAINNET';
const REGTEST_PIN = 'CHECKPOINT_VALIDATORS_BTC_REGTEST';

function pinned(pubkey = 'a'.repeat(64), source = 'source-1'){
    return JSON.stringify([{ pubkey, weight: '1', source }]);
}

function resolve(network, snapshotBlock, values){
    return resolveTrustSet(network, snapshotBlock, (name) => values[name]);
}

function assertHeld(actual, variable, detail){
    assert.strictEqual(actual.trustSet, null);
    assert.strictEqual(actual.firstUse, false);
    assert.strictEqual(actual.held, true);
    assert.match(actual.reason, new RegExp(variable));
    if(detail) assert.match(actual.reason, detail);
}

function assertUsable(actual, pubkey){
    assert.deepStrictEqual(actual, {
        trustSet: [{ pubkey, weight: '1', source: 'source-1' }],
        firstUse: false,
        held: false,
        reason: null,
    });
}

describe('capability snapshot proof trust set', function () {
    it('holds testnet and mainnet when no pin is configured', function () {
        assertHeld(resolve('testnet', 10, {}), TESTNET_PIN);
        assertHeld(resolve('mainnet', 10, {}), MAINNET_PIN);
    });

    it('holds blank, invalid, and empty-array testnet pins', function () {
        assertHeld(resolve('testnet', 10, { [TESTNET_PIN]: '  ' }), TESTNET_PIN, /not configured/);
        assertHeld(resolve('testnet', 10, { [TESTNET_PIN]: 'not json' }), TESTNET_PIN, /not valid JSON/);
        assertHeld(resolve('testnet', 10, { [TESTNET_PIN]: '[]' }), TESTNET_PIN, /empty array/);
    });

    it('uses a valid static pin', function () {
        const pubkey = 'a'.repeat(64);
        assertUsable(resolve('testnet', 10, { [TESTNET_PIN]: pinned(pubkey) }), pubkey);
    });

    it('uses the static pin below _FROM and the _NEXT pin at and above it', function () {
        const current = 'a'.repeat(64);
        const next = 'b'.repeat(64);
        const values = {
            [TESTNET_PIN]: pinned(current),
            [TESTNET_PIN + '_NEXT']: pinned(next),
            [TESTNET_PIN + '_FROM']: '100',
        };
        assertUsable(resolve('testnet', 99, values), current);
        assertUsable(resolve('testnet', 100, values), next);
        assertUsable(resolve('testnet', 500, values), next);
    });

    it('holds a testnet rotation with a bad _FROM value', function () {
        assertHeld(resolve('testnet', 500, {
            [TESTNET_PIN]: pinned(),
            [TESTNET_PIN + '_NEXT']: pinned('b'.repeat(64)),
            [TESTNET_PIN + '_FROM']: 'x',
        }), TESTNET_PIN + '_FROM');
    });

    it('holds an invalid _NEXT pin after rotation', function () {
        assertHeld(resolve('testnet', 500, {
            [TESTNET_PIN]: pinned(),
            [TESTNET_PIN + '_NEXT']: '{}',
            [TESTNET_PIN + '_FROM']: '100',
        }), TESTNET_PIN + '_NEXT', /not a JSON array/);
    });

    it('allows first use on regtest only when no pin is configured', function () {
        assert.deepStrictEqual(resolve('regtest', 10, {}), {
            trustSet: null,
            firstUse: true,
            held: false,
            reason: null,
        });
    });

    it('holds a regtest rotation with a bad _FROM value', function () {
        assertHeld(resolve('regtest', 10, {
            [REGTEST_PIN + '_NEXT']: pinned(),
            [REGTEST_PIN + '_FROM']: 'x',
        }), REGTEST_PIN + '_FROM');
    });

    it('holds an invalid regtest pin instead of treating it as first use', function () {
        assertHeld(resolve('regtest', 10, { [REGTEST_PIN]: 'not json' }), REGTEST_PIN, /not valid JSON/);
    });

    it('uses a valid regtest pin', function () {
        const pubkey = 'c'.repeat(64);
        assertUsable(resolve('regtest', 10, { [REGTEST_PIN]: pinned(pubkey) }), pubkey);
    });

    it('uses the default reader through process.env', function () {
        const names = [TESTNET_PIN, TESTNET_PIN + '_NEXT', TESTNET_PIN + '_FROM'];
        const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
        try {
            process.env[TESTNET_PIN] = pinned('d'.repeat(64));
            delete process.env[TESTNET_PIN + '_NEXT'];
            delete process.env[TESTNET_PIN + '_FROM'];
            assertUsable(resolveTrustSet('testnet', 10), 'd'.repeat(64));
        } finally {
            for(const name of names){
                if(saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
        }
    });
});
