// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const {
    isBridgeMirrorLeg,
    classifyTickItem,
} = require('../../../../src/actions/list/tick_coin_rules.js');

const CONFIG = {
    COINS: ['BTC', 'LTC', 'DOGE'],
    MIN_TICK_LENGTH: 1,
    MAX_TICK_LENGTH: 20,
    TICK_CHARACTERS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ADDRESS: { BRIDGE_DOGE: 'doge-bridge' },
};

function classify(item, mirrorLeg = false){
    return classifyTickItem(item, {
        coin: 'BTC',
        coins: CONFIG.COINS,
        config: CONFIG,
        mirrorLeg,
    });
}

describe('LIST tick coin rules', function(){
    describe('classifyTickItem', function(){
        it('accepts foreign coin items and canonicalizes their roots', function(){
            assert.deepStrictEqual(classify('DOGE:PEPE'), {
                path: 'valid', item: 'DOGE:PEPE'
            });
            assert.deepStrictEqual(classify('doge:^12'), {
                path: 'valid', item: 'DOGE:^12'
            });
            assert.deepStrictEqual(classify('eth:USDC'), {
                path: 'valid', item: 'ETH:USDC'
            });
        });

        it('looks up the rest of well-formed own-coin items', function(){
            assert.deepStrictEqual(classify('BTC:FOO'), {
                path: 'lookup', item: 'FOO'
            });
            assert.deepStrictEqual(classify('BTC:^5'), {
                path: 'lookup', item: '^5'
            });
        });

        it('reports malformed qualified items under their written keys', function(){
            assert.deepStrictEqual(classify('DOGE:^012'), {
                path: 'format', item: 'DOGE:^012'
            });
            assert.deepStrictEqual(classify('doge:^012'), {
                path: 'format', item: 'doge:^012'
            });
        });

        it('looks up unqualified items unchanged', function(){
            for(let item of ['FOO:BAR', ':PEPE', 'PEPE'])
                assert.deepStrictEqual(classify(item), { path: 'lookup', item });
        });

        it('accepts qualified mirror-leg items without checking their form', function(){
            assert.deepStrictEqual(classify('BTC:NOPE', true), {
                path: 'valid', item: 'BTC:NOPE'
            });
            assert.deepStrictEqual(classify('DOGE:^012', true), {
                path: 'valid', item: 'DOGE:^012'
            });
        });
    });

    describe('isBridgeMirrorLeg', function(){
        it('recognizes a genesis leg from a configured coin bridge', function(){
            assert.strictEqual(isBridgeMirrorLeg({
                IS_GENESIS: true,
                SOURCE: 'doge-bridge',
            }, CONFIG), true);
        });

        it('rejects non-genesis legs and legs from other sources', function(){
            assert.strictEqual(isBridgeMirrorLeg({
                SOURCE: 'doge-bridge',
            }, CONFIG), false);
            assert.strictEqual(isBridgeMirrorLeg({
                IS_GENESIS: true,
                SOURCE: 'other',
            }, CONFIG), false);
        });

        it('rejects missing data and configuration pieces', function(){
            assert.strictEqual(isBridgeMirrorLeg(null, CONFIG), false);
            assert.strictEqual(isBridgeMirrorLeg({ IS_GENESIS: true }, CONFIG), false);
            assert.strictEqual(isBridgeMirrorLeg({
                IS_GENESIS: true,
                SOURCE: 'doge-bridge',
            }, { COINS: CONFIG.COINS }), false);
        });
    });
});
