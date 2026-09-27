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
    sectionOrderReason,
    sigOrderReason
} = require('../../../../src/actions/anchor/validate.js');

function sectionWalkReasons(chains){
    let prevChain = null;
    return chains.map(chain => {
        let reason = sectionOrderReason(prevChain, { CHAIN: chain });
        prevChain = chain;
        return reason;
    });
}

describe('ANCHOR order reason helpers', function () {
    it('accepts sections in plain-string CHAIN order', function () {
        assert.deepStrictEqual(sectionWalkReasons(['BTC', 'DOGE', 'LTC']), [null, null, null]);
    });

    it('flags a CHAIN that sorts before its predecessor', function () {
        assert.deepStrictEqual(sectionWalkReasons(['DOGE', 'BTC']), [null, 'CHAIN (order)']);
    });

    it('never flags the first section', function () {
        assert.strictEqual(sectionOrderReason(null, { CHAIN: 'DOGE' }), null);
    });

    it('accepts sorted, empty, and one-element signature lists', function () {
        assert.strictEqual(sigOrderReason([{ pubkey: 'a' }, { pubkey: 'b' }]), null);
        assert.strictEqual(sigOrderReason([]), null);
        assert.strictEqual(sigOrderReason([{ pubkey: 'a' }]), null);
    });

    it('flags a pubkey that sorts before its predecessor', function () {
        assert.strictEqual(sigOrderReason([{ pubkey: 'b' }, { pubkey: 'a' }]), 'SIGS (order)');
    });
});
