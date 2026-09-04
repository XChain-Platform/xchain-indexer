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
// Attestation framework spec §11. Two consensus surfaces live in this
// module and both are asserted here: the flag-day predicate that decides WHEN the
// leader broadcast-fee carve-out applies, and the per-provider cap resolver that
// decides HOW MUCH it may ever be. The cap is the bound that keeps a hostile
// ATTESTATION.PROVIDERS overlay from draining a request author's escrow into the
// leader's pocket, so the HARD_MAX clamp is the load-bearing assertion in the file.

'use strict';

const assert = require('assert');
const abf    = require('../../src/attest_broadcast_fee_activation.js');

describe('ATTEST broadcast-fee activation (spec §11) @regression', function () {

    describe('isAttestBroadcastFeeActive', function () {

        it('is INERT on mainnet: the operator still owns that height', function () {
            assert.strictEqual(abf.ATTEST_BROADCAST_FEE_ACTIVATION.mainnet, null);
            // A null threshold must read as OFF at every height, including absurd ones:
            // a `blockIndex >= null` coercion would read 0 and arm the gate from genesis.
            for (const h of [0, 1, 961000, 999999999])
                assert.strictEqual(abf.isAttestBroadcastFeeActive(h, 'mainnet'), false,
                    'an unallocated height must never arm at ' + h);
        });

        it('is armed from genesis on testnet and regtest so both exercise the carve-out', function () {
            // testnet 0 is operator-ratified (2026-08-18) and safe by MEASUREMENT: this gate
            // only changes how a fulfilled settle splits its escrow, and the live explorer
            // reports zero attestation rows ever recorded on any testnet chain, so there is
            // no historical reward split to reinterpret.
            for (const net of ['testnet', 'regtest']) {
                assert.strictEqual(abf.ATTEST_BROADCAST_FEE_ACTIVATION[net], 0, net + ' must be armed at genesis');
                assert.strictEqual(abf.isAttestBroadcastFeeActive(0, net), true);
                assert.strictEqual(abf.isAttestBroadcastFeeActive(12345, net), true);
            }
        });

        it('an unknown network fails closed rather than defaulting to on', function () {
            assert.strictEqual(abf.isAttestBroadcastFeeActive(999999, 'signet'), false);
            assert.strictEqual(abf.isAttestBroadcastFeeActive(999999, undefined), false);
        });

        it('an unparseable height fails closed', function () {
            for (const h of [null, undefined, 'nope', NaN, {}])
                assert.strictEqual(abf.isAttestBroadcastFeeActive(h, 'regtest'), false);
        });

        it('uses >= semantics at the threshold block itself', function () {
            // Exercised through a network whose threshold is a real number; regtest's 0 is
            // the only armed one shipped, so the boundary is genesis.
            assert.strictEqual(abf.isAttestBroadcastFeeActive(-1, 'regtest'), false);
            assert.strictEqual(abf.isAttestBroadcastFeeActive(0, 'regtest'), true);
        });
    });

    describe('broadcastFeeCapNative', function () {

        it('returns the shipped per-provider allowance for a known provider', function () {
            assert.strictEqual(abf.broadcastFeeCapNative('http_get', { provider_id: 'http_get' }), '0.00010000');
            assert.strictEqual(abf.broadcastFeeCapNative('llm', { provider_id: 'llm' }), '0.00010000');
        });

        it('falls back to DEFAULT for a provider this map does not name', function () {
            assert.strictEqual(abf.broadcastFeeCapNative('operator_registered', { provider_id: 'x' }),
                abf.ATTEST_BROADCAST_FEE_CAP.DEFAULT);
            assert.strictEqual(abf.broadcastFeeCapNative('operator_registered', null),
                abf.ATTEST_BROADCAST_FEE_CAP.DEFAULT);
        });

        it('honours an overlay allowance BELOW the hard max', function () {
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.00002' }), '0.00002000');
        });

        it('CLAMPS an overlay allowance to HARD_MAX: an overlay cannot widen the bound', function () {
            // The escrow-drain case. Without this clamp a config-registered provider could
            // set an allowance larger than any request fee and take the whole escrow.
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '100000' }),
                Number(abf.ATTEST_BROADCAST_FEE_CAP.HARD_MAX).toFixed(8));
            assert.strictEqual(
                abf.broadcastFeeCapNative('llm', { broadcast_fee_cap_native: '0.5' }), '0.00100000');
        });

        it('ignores a malformed or negative overlay and uses the shipped value instead', function () {
            for (const bad of ['', '   ', 'abc', '-1', 'Infinity', null, undefined, {}, []])
                assert.strictEqual(
                    abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: bad }), '0.00010000',
                    'malformed overlay value ' + JSON.stringify(bad) + ' must not change the allowance');
        });

        it('renders at fixed 8dp so the string a node compares is byte-stable', function () {
            const v = abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.1' });
            assert.ok(/^\d+\.\d{8}$/.test(v), 'expected fixed 8dp, got ' + v);
        });

        it('every shipped allowance is itself within HARD_MAX', function () {
            const hardMax = Number(abf.ATTEST_BROADCAST_FEE_CAP.HARD_MAX);
            assert.ok(Number(abf.ATTEST_BROADCAST_FEE_CAP.DEFAULT) <= hardMax, 'DEFAULT exceeds HARD_MAX');
            for (const [id, v] of Object.entries(abf.ATTEST_BROADCAST_FEE_CAP.PROVIDERS))
                assert.ok(Number(v) <= hardMax, id + ' allowance exceeds HARD_MAX');
        });

        it('FLOORS an overlay finer than a satoshi instead of rounding it up', function () {
            // The float parse rendered '0.000000019' as '0.00000002' and '0.000012345678' as
            // '0.00001235', paying the leader more out of the AUTHOR's escrow than the overlay
            // allowed. Floor is the direction bcmulfloor/bcmuldivfloor already take.
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.000000019' }),
                '0.00000001');
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.000012345678' }),
                '0.00001234');
        });

        it('clamps on an EXACT compare against HARD_MAX, not a float near-miss', function () {
            // Number('0.0009999999999999999') lands below the double nearest 0.001, so the old
            // path skipped the clamp and then toFixed(8) rounded the value back UP to the
            // hard max. Exact arithmetic keeps it one satoshi under.
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.0009999999999999999' }),
                '0.00099999');
            // Equal to HARD_MAX is not clamped away.
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.00100000' }),
                '0.00100000');
        });

        it('rejects sign / exponent / hex forms a float parse used to swallow', function () {
            // Number() accepted every one of these and re-rendered it as a cap no operator
            // typed: '+0.1', '.5' and '0x10' all clamped to the hard max.
            for (const bad of ['+0.1', '.5', '1e-4', '0.5e1', '0x10', '1_0'])
                assert.strictEqual(
                    abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: bad }), '0.00010000',
                    'non-plain-decimal overlay ' + JSON.stringify(bad) + ' must not change the allowance');
        });

        it('is exact at one satoshi and above 2^53 coins', function () {
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '0.00000001' }),
                '0.00000001');
            assert.strictEqual(
                abf.broadcastFeeCapNative('http_get', { broadcast_fee_cap_native: '99999999999999999999' }),
                '0.00100000');
        });

        it('names an allowance for every provider the indexer registry ships', function () {
            // A provider with no named allowance silently falls to DEFAULT, which is a
            // policy choice that should be made deliberately rather than by omission.
            const registry = require('../../src/attestation/providerRegistry.js');
            for (const id of Object.keys(registry.PROVIDERS))
                assert.ok(
                    Object.prototype.hasOwnProperty.call(abf.ATTEST_BROADCAST_FEE_CAP.PROVIDERS, id),
                    'provider "' + id + '" has no named broadcast-fee allowance');
        });
    });
});
