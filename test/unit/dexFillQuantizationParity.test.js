'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
//  P1 (): the INDEXER half of the shared fill-quantization
// contract. The indexer is the arbiter here; the hub's CrossChainDexEngine is a
// hand port that must reproduce these numbers exactly. The vectors are vendored
// byte-identically into xchain-hub/test/fixtures/, and each side asserts its own
// half so neither can drift alone.
//
// The indexer side was already correct at HEAD (precision 64 plus a tick-grid
// bcround on both derived amounts). These tests exist so it STAYS correct: it is
// the reference the hub is being aligned to, and an unnoticed edit here would
// silently move the target rather than surface as a hub bug.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const Utility = require('../../src/utility.js');

const FIXTURE = path.join(__dirname, '../fixtures/dex-fill-quantization-vectors.json');
const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

describe('DEX fill quantization parity, indexer half (#3145/#3146) @regression @tier1', function () {

    const util = new Utility();

    describe('precision alignment (the reference the hub is ported to)', function () {
        for (const v of vectors.precision_alignment) {
            it(`${v.label}: derives at precision 64`, function () {
                const giveSide = v.clamped_side === 'give';
                const operand  = giveSide ? v.max_give  : v.max_get;
                const rate     = giveSide ? v.give_price : v.get_price;
                const exp64    = giveSide ? v.derived_get_at_64 : v.at_precision_64;

                assert.strictEqual(String(util.bcmul(operand, rate, 64)),
                                   String(util.bcnum(exp64)),
                    'the indexer defines the expected value; a change here moves the contract');

                if (giveSide) {
                    assert.strictEqual(String(util.bcmul(v.max_get, v.get_price, 64)),
                                       String(util.bcnum(v.give_from_get_at_64)));
                }
            });
        }

        it('order_match.js multiplies at 64 at both clamp sites', function () {
            // Source-level pin, mirroring the hub half. These are the numbers the hub is
            // being aligned to, so a silent drop to a lower precision here would make the
            // hub "wrong" against a target that had moved.
            const src = fs.readFileSync(path.join(__dirname, '../../src/actions/order_match.js'), 'utf8');
            const muls = src.match(/bcmul\((?:max_get|max_give),\s*orderInfo\['(?:GET|GIVE)_PRICE'\],\s*(\d+)\)/g) || [];
            assert.strictEqual(muls.length, 2, 'expected exactly the two clamp multiplications');
            for (const m of muls) assert.match(m, /,\s*64\)$/);
        });
    });

    describe('tick quantization (indexer-only until offers carry decimals)', function () {
        for (const v of vectors.tick_quantization) {
            it(`${v.label}: bcround(${v.amount}, ${v.decimals}) -> ${v.expected}`, function () {
                assert.strictEqual(String(util.bcround(v.amount, v.decimals)),
                                   String(util.bcnum(v.expected)));
            });
        }

        it('a fill that quantizes to zero is dropped, not settled as dust', function () {
            const dust = vectors.tick_quantization.find(v => v.fill_dropped);
            assert.ok(dust, 'the fixture must carry a dust vector');
            const rounded = util.bcround(dust.amount, dust.decimals);
            assert.ok(util.bclte(rounded, 0),
                'order_match.js drops the fill when either side rounds to zero');
        });

        it('order_match.js still snaps BOTH derived amounts onto their own tick grid', function () {
            // This is the leg the spec claimed was missing here. It is present, and it is
            // what the hub cannot yet reproduce; if it were ever removed, the two engines
            // would agree by both being wrong, which no value-level test would catch.
            const src = fs.readFileSync(path.join(__dirname, '../../src/actions/order_match.js'), 'utf8');
            assert.match(src, /give_amount\s*=\s*this\.util\.bcround\(give_amount,\s*giveDecimals\)/,
                'give side must be quantized to its own tick decimals');
            assert.match(src, /get_amount\s*=\s*this\.util\.bcround\(get_amount,\s*getDecimals\)/,
                'get side must be quantized to its own tick decimals');
        });

        it('uses each side\'s OWN decimals, never one shared value', function () {
            // A 0-decimal (NFT) tick swapped against an 8-decimal token is the case that
            // breaks if the two sides ever share a decimals variable.
            assert.strictEqual(String(util.bcround('1.6', 0)), '2');
            assert.strictEqual(String(util.bcround('1.6', 8)), '1.6');
        });
    });

    describe('the shared fixture is byte-identical to the hub copy', function () {
        it('matches the canonical xchain-hub copy when the sibling is present', function () {
            const sibling = path.join(__dirname,
                '../../../xchain-hub/test/fixtures/dex-fill-quantization-vectors.json');
            if (!fs.existsSync(sibling)) return this.skip();
            assert.strictEqual(fs.readFileSync(FIXTURE, 'utf8'), fs.readFileSync(sibling, 'utf8'),
                'the two vendored copies drifted; a fill-quantization vector must never ' +
                'differ between the two repos that implement it');
        });
    });
});
