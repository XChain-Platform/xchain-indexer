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
    trustPinEnvNames,
    selectTrustPinRaw,
} = require('../../../../src/consensus/capability_snapshot_proof/trust_pin.js');

const TESTNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';

function reader(values){
    return (name) => values[name];
}

function select(values, snapshotBlock){
    return selectTrustPinRaw('testnet', snapshotBlock, reader(values));
}

describe('capability snapshot proof trust pin', function () {
    it('builds the testnet and mainnet environment names', function () {
        assert.deepStrictEqual(trustPinEnvNames('testnet'), {
            pin: TESTNET_PIN,
            next: TESTNET_PIN + '_NEXT',
            from: TESTNET_PIN + '_FROM',
        });
        assert.deepStrictEqual(trustPinEnvNames('mainnet'), {
            pin: 'CHECKPOINT_VALIDATORS_BTC_MAINNET',
            next: 'CHECKPOINT_VALIDATORS_BTC_MAINNET_NEXT',
            from: 'CHECKPOINT_VALIDATORS_BTC_MAINNET_FROM',
        });
    });

    it('selects the static pin when no rotation is configured', function () {
        assert.deepStrictEqual(select({ [TESTNET_PIN]: 'P0' }, 900), {
            name: TESTNET_PIN,
            raw: 'P0',
            error: null,
        });
    });

    it('selects the static pin below the rotation block', function () {
        const values = {
            [TESTNET_PIN]: 'P0',
            [TESTNET_PIN + '_NEXT']: 'P1',
            [TESTNET_PIN + '_FROM']: '1000',
        };
        assert.deepStrictEqual(select(values, 999), {
            name: TESTNET_PIN,
            raw: 'P0',
            error: null,
        });
    });

    it('selects the next pin at and above the rotation block', function () {
        const values = {
            [TESTNET_PIN]: 'P0',
            [TESTNET_PIN + '_NEXT']: 'P1',
            [TESTNET_PIN + '_FROM']: '1000',
        };
        const expected = {
            name: TESTNET_PIN + '_NEXT',
            raw: 'P1',
            error: null,
        };
        assert.deepStrictEqual(select(values, 1000), expected);
        assert.deepStrictEqual(select(values, 5000), expected);
    });

    it('holds a configured next pin when the rotation block is invalid', function () {
        const invalid = [undefined, '', ' ', '-1', '1.5', 'x', '9007199254740992'];
        for(const from of invalid){
            const actual = select({
                [TESTNET_PIN]: 'P0',
                [TESTNET_PIN + '_NEXT']: 'P1',
                [TESTNET_PIN + '_FROM']: from,
            }, 5000);
            assert.strictEqual(actual.name, TESTNET_PIN + '_FROM');
            assert.strictEqual(actual.raw, null);
            assert.match(actual.error, /CHECKPOINT_VALIDATORS_BTC_TESTNET_FROM/);
        }
    });

    it('ignores a rotation block when no next pin is configured', function () {
        assert.deepStrictEqual(select({
            [TESTNET_PIN]: 'P0',
            [TESTNET_PIN + '_FROM']: '10',
        }, 50), {
            name: TESTNET_PIN,
            raw: 'P0',
            error: null,
        });
    });

    it('returns null for an unset or blank static pin', function () {
        for(const raw of [undefined, '', '   ']){
            const values = raw === undefined ? {} : { [TESTNET_PIN]: raw };
            assert.deepStrictEqual(select(values, 10), {
                name: TESTNET_PIN,
                raw: null,
                error: null,
            });
        }
    });

    it('uses the call-time environment reader by default', function () {
        const names = trustPinEnvNames('testnet');
        const saved = Object.fromEntries(Object.values(names).map((name) => [name, process.env[name]]));
        try {
            process.env[names.pin] = 'ENVPIN';
            delete process.env[names.next];
            delete process.env[names.from];
            assert.deepStrictEqual(selectTrustPinRaw('testnet', 1), {
                name: TESTNET_PIN,
                raw: 'ENVPIN',
                error: null,
            });
        } finally {
            for(const name of Object.values(names)){
                if(saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
        }
    });
});
