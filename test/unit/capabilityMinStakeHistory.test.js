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
// : the capability MIN_STAKE a validator set was locked at is BLOCK-ANCHORED.
// xchain-hub resolves it through CapabilityRegistry.getMinStake(capability, blockIndex) and
// hands it to the indexer, which honours it VERBATIM. Any verifier re-deriving a HISTORICAL
// set (archive recovery, with no hub left to ask) has to reconstruct the same value from the
// block alone, or it judges an archive at a bar that archive was never built at.
//
// This suite pins the reconstruction rule against the hub's, and pins that the frozen table
// ships INERT so today's behaviour is the genesis floor on every network.

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const cmsh = require('../../src/capability_min_stake_history.js');

describe('capability MIN_STAKE as-of-block reconstruction  @regression @tier2', function () {

    describe('the frozen activation table', function () {

        it('is INERT on every network, so the effective bar is the genesis floor', function () {
            // Arming an entry changes ACCEPTANCE (which archives verify, and on the live path
            // which validators qualify), so it is a coordinated flag day landed in the same
            // release as the matching hub-side history - never an edit made here alone.
            for (let net of ['mainnet', 'testnet', 'regtest']) {
                assert.ok(cmsh.MIN_STAKE_ACTIVATIONS[net], 'every network must have an entry: ' + net);
                assert.deepStrictEqual(Object.keys(cmsh.MIN_STAKE_ACTIVATIONS[net]), [],
                    net + ' has an armed MIN_STAKE activation; the hub still pins governance MIN_STAKE ' +
                    'changes OFF (CapabilityRegistry.MIN_STAKE_GOVERNANCE_DISABLED), so an entry here ' +
                    'would fork the fleet');
            }
        });

        it('resolves to the supplied genesis floor for every capability, unarmed', function () {
            for (let net of ['mainnet', 'testnet', 'regtest'])
                for (let cap of ['cross_chain', 'oracle_publish', 'price', 'attestation'])
                    assert.strictEqual(cmsh.minStakeAt(cap, 900000, net, '5000.00000000'), '5000.00000000');
        });
    });

    describe('minStakeAt', function () {

        // The shape xchain-hub CapabilityRegistry.minStakeHistory carries: ascending
        // { activation_block, value }, each in force until the next one.
        const HIST = { cross_chain: [{ activation_block: 0,    value: '100' },
                                     { activation_block: 5000, value: '250' },
                                     { activation_block: 9000, value: '80'  }] };

        it('returns the entry in force at the block, mirroring hub getMinStake', function () {
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 0,    'mainnet', '1', HIST), '100');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 4999, 'mainnet', '1', HIST), '100');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 5000, 'mainnet', '1', HIST), '250');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 8999, 'mainnet', '1', HIST), '250');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 9000, 'mainnet', '1', HIST), '80');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 1e9,  'mainnet', '1', HIST), '80');
        });

        it('takes effect AT the activation block, not one block early or late', function () {
            // The boundary is the whole point of a block-anchored history: two hubs applying a
            // finalized change at different wall-clock moments still agree on every block.
            let h = { price: [{ activation_block: 777, value: '9' }] };
            assert.strictEqual(cmsh.minStakeAt('price', 776, 'mainnet', '1', h), '1');
            assert.strictEqual(cmsh.minStakeAt('price', 777, 'mainnet', '1', h), '9');
        });

        it('falls back to the genesis floor for a capability the history does not name', function () {
            assert.strictEqual(cmsh.minStakeAt('attestation', 9999, 'mainnet', '42', HIST), '42');
        });

        it('returns null when nothing is resolvable, so the caller passes NO override', function () {
            // Null is load-bearing: recovery passes no minStake, db.js applies its own local
            // floor, and a handle with no coin config behaves exactly as it did pre-
            // instead of failing on a threshold it cannot know.
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 100, 'mainnet', null), null);
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 100, 'mainnet', undefined), null);
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 100, 'mainnet', ''), null);
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 100, 'mainnet', 'not-a-number'), null);
        });

        it('falls back to the genesis floor, never to a bar of its own, on unusable input', function () {
            for (let bad of [null, undefined, '', false, NaN, 'abc'])
                assert.strictEqual(cmsh.minStakeAt('cross_chain', bad, 'mainnet', '7', HIST), '7',
                    'unparseable height must resolve to genesis, not to an activation entry');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 100, 'no-such-network', '7'), '7');
        });

        it('ignores a malformed entry instead of adopting it', function () {
            let h = { cross_chain: [{ activation_block: 0, value: '100' },
                                    { activation_block: 10, value: 'wat' },       // malformed value
                                    { activation_block: -5, value: '1' },         // malformed block
                                    { activation_block: 20, value: null }] };
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 50, 'mainnet', '1', h), '100');
        });

        it('an override wins over the frozen table, and only an OPERATOR may supply one', function () {
            // db.js honours a caller-supplied threshold verbatim for the same reason: local
            // config drifts between independently-operated indexers. What must never reach it
            // is anything ARCHIVE-derived - that was the #4269 forge.
            let h = { cross_chain: [{ activation_block: 0, value: '250' }] };
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 10, 'regtest', '1', h), '250');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 10, 'regtest', '1'), '1');
        });

        it('is not fooled by an empty-ish height picking up a block-0 activation', function () {
            // Number(null) and Number('') are a perfectly finite 0, which would read as
            // "at/after the genesis activation" and silently apply it.
            let h = { cross_chain: [{ activation_block: 0, value: '999' }] };
            assert.strictEqual(cmsh.minStakeAt('cross_chain', null, 'mainnet', '3', h), '3');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', '',   'mainnet', '3', h), '3');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', false,'mainnet', '3', h), '3');
            assert.strictEqual(cmsh.minStakeAt('cross_chain', 0,    'mainnet', '3', h), '999');
        });
    });

    describe('amount arithmetic (as-of-block weight restoration)', function () {

        it('adds full-precision decimal strings, never JS doubles', function () {
            assert.ok(cmsh.amountsEqual(cmsh.addAmount('0.1', '0.2'), '0.3'),
                      '0.1 + 0.2 must be exactly 0.3, not 0.30000000000000004');
            assert.strictEqual(cmsh.addAmount('2', '3'), '5');
            assert.ok(cmsh.amountsEqual(cmsh.addAmount('99999999999999.99999999', '0.00000001'),
                                        '100000000000000'));
        });

        it('treats an unusable operand as nothing added, not as a failure', function () {
            assert.strictEqual(cmsh.addAmount('5', null), '5');
            assert.strictEqual(cmsh.addAmount('5', 'wat'), '5');
        });

        it('compares by value, so 5 and 5.00000000 are the same weight', function () {
            assert.ok(cmsh.amountsEqual('5', '5.00000000'));
            assert.strictEqual(cmsh.cmpAmount('5', '5.00000001'), -1);
            assert.strictEqual(cmsh.cmpAmount('5.00000001', '5'), 1);
            assert.strictEqual(cmsh.cmpAmount('5', '5'), 0);
        });

        it('reports an unusable operand rather than a bogus zero comparison', function () {
            assert.strictEqual(cmsh.cmpAmount('5', null), null);
            assert.strictEqual(cmsh.cmpAmount('-1', '5'), null, 'a negative weight is not a valid amount');
            assert.strictEqual(cmsh.amountsEqual(null, null), false);
        });
    });

    describe('hub parity', function () {

        it('resolves the same rule the hub CapabilityRegistry does', function () {
            // The two implementations are independent (different repos, different storage), so
            // the pin is on the RULE: greatest activation_block <= blockIndex wins. A drift
            // here means recovery judges an archive at a bar the hub never used.
            let hubPath = path.resolve(__dirname, '../../../xchain-hub/src/CapabilityRegistry.js');
            if (!fs.existsSync(hubPath)) return this.skip();
            let src = fs.readFileSync(hubPath, 'utf8');
            assert.ok(/if\s*\(e\.activation_block <= blockIndex\)\s*resolved = e\.value;/.test(src),
                'xchain-hub CapabilityRegistry.getMinStake no longer resolves "greatest activation_block ' +
                '<= blockIndex"; capability_min_stake_history.minStakeAt must be re-derived to match');
        });
    });
});
