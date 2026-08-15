/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/attestation/providerMinStakeHistory.test.js
 *
 * The provider stake floor is a consensus value resolved as a function of block
 * height, mirroring xchain-hub ProviderRegistry.getMinStake. These tests pin the
 * two properties that make it fork-proof:
 *   1. the frozen activation table is EMPTY on every network, so today every node
 *      resolves the shipped genesis floor at every block (arming an entry is a
 *      coordinated fleet release, not a config edit);
 *   2. the floor predicate is EXACT decimal comparison with fail-closed handling
 *      of anything unusable, never a float and never an epsilon-tolerant compare.
 */

'use strict';

const assert = require('assert');

const pmsh = require('../../../src/attestation/providerMinStakeHistory.js');

describe('providerMinStakeHistory @regression @tier1', function () {

    describe('the frozen activation table', function () {

        it('declares all three networks and arms nothing on any of them', function () {
            const t = pmsh.PROVIDER_MIN_STAKE_ACTIVATIONS;
            assert.deepStrictEqual(Object.keys(t).sort(), ['mainnet', 'regtest', 'testnet']);
            for (const net of Object.keys(t))
                assert.deepStrictEqual(t[net], {},
                    net + ' has an armed provider-floor activation; that is a consensus flag day ' +
                    'and must land in the same release as the matching hub-side governance activation');
        });
    });

    describe('providerMinStakeAt', function () {

        it('returns the genesis floor when no activation applies', function () {
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 100, 'mainnet', '10000'), '10000');
        });

        it('normalises the genesis floor to a plain decimal string', function () {
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 100, 'mainnet', ' 10000 '), '10000');
        });

        it('returns null when neither history nor genesis floor can be resolved', function () {
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 100, 'mainnet', undefined), null);
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 100, 'mainnet', 'ten thousand'), null);
        });

        it('an unknown network falls back to the genesis floor rather than inventing a bar', function () {
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 100, 'no-such-net', '10000'), '10000');
        });

        it('picks the greatest activation_block at or below the height', function () {
            const ov = { llm: [
                { activation_block: 100, value: '20000' },
                { activation_block: 500, value: '40000' }
            ] };
            assert.strictEqual(pmsh.providerMinStakeAt('llm', 99,  'mainnet', '25000', ov), '25000');
            assert.strictEqual(pmsh.providerMinStakeAt('llm', 100, 'mainnet', '25000', ov), '20000');
            assert.strictEqual(pmsh.providerMinStakeAt('llm', 499, 'mainnet', '25000', ov), '20000');
            assert.strictEqual(pmsh.providerMinStakeAt('llm', 500, 'mainnet', '25000', ov), '40000');
        });

        it('is order-independent: a table listed descending resolves identically', function () {
            const asc  = { llm: [{ activation_block: 100, value: '20000' }, { activation_block: 500, value: '40000' }] };
            const desc = { llm: [{ activation_block: 500, value: '40000' }, { activation_block: 100, value: '20000' }] };
            for (const b of [99, 100, 300, 500, 900])
                assert.strictEqual(pmsh.providerMinStakeAt('llm', b, 'mainnet', '25000', asc),
                                   pmsh.providerMinStakeAt('llm', b, 'mainnet', '25000', desc));
        });

        it('ignores a malformed entry instead of guessing at it', function () {
            const ov = { llm: [
                { activation_block: -1,    value: '1' },
                { activation_block: 'abc', value: '2' },
                { activation_block: 100,   value: 'not-a-number' }
            ] };
            assert.strictEqual(pmsh.providerMinStakeAt('llm', 900, 'mainnet', '25000', ov), '25000');
        });

        it('an empty-ish height cannot pick up a block-0 activation', function () {
            // Number(null) and Number('') are both a perfectly finite 0, which would
            // otherwise silently arm a block-0 entry for a caller with no height.
            const ov = { llm: [{ activation_block: 0, value: '40000' }] };
            for (const h of [null, undefined, '', false])
                assert.strictEqual(pmsh.providerMinStakeAt('llm', h, 'mainnet', '25000', ov), '25000');
        });

        it('a provider with no entry in an armed table keeps its genesis floor', function () {
            const ov = { llm: [{ activation_block: 0, value: '40000' }] };
            assert.strictEqual(pmsh.providerMinStakeAt('http_get', 900, 'mainnet', '10000', ov), '10000');
        });
    });

    describe('meetsProviderFloor', function () {

        it('is inclusive at the boundary and scale-insensitive', function () {
            assert.strictEqual(pmsh.meetsProviderFloor('25000', '25000'), true);
            assert.strictEqual(pmsh.meetsProviderFloor('25000.00000000', '25000'), true);
            assert.strictEqual(pmsh.meetsProviderFloor('25000', '25000.00000000'), true);
        });

        it('rejects one satoshi under the floor (exact, not epsilon-tolerant)', function () {
            assert.strictEqual(pmsh.meetsProviderFloor('24999.99999999', '25000'), false);
            // mathjs.largerEq would call these equal at its ~1e-12 relative epsilon.
            assert.strictEqual(pmsh.meetsProviderFloor('0.000000000000001', '0.000000000000002'), false);
        });

        it('excludes an unusable weight rather than reading it as 0', function () {
            for (const w of [null, undefined, '', 'lots', '-5', true, {}, NaN])
                assert.strictEqual(pmsh.meetsProviderFloor(w, '0'), false, String(w) + ' must not clear a floor');
        });

        it('excludes everything when the floor itself is unusable (fail closed)', function () {
            for (const f of [null, undefined, '', 'ten thousand', '-1'])
                assert.strictEqual(pmsh.meetsProviderFloor('999999', f), false);
        });

        it('a floor of 0 admits a zero weight but still rejects garbage', function () {
            assert.strictEqual(pmsh.meetsProviderFloor('0', '0'), true);
            assert.strictEqual(pmsh.meetsProviderFloor('garbage', '0'), false);
        });

        it('handles amounts far above JS integer precision exactly', function () {
            assert.strictEqual(pmsh.meetsProviderFloor('9007199254740993', '9007199254740992'), true);
            assert.strictEqual(pmsh.meetsProviderFloor('9007199254740992', '9007199254740993'), false);
        });
    });
});
