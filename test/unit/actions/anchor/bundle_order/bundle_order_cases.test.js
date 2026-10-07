// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    PUBKEY_A, PUBKEY_B, v0Params, armAnchor, disarmAnchor
} = require('../anchor.test/helpers/anchor_fixtures.js');
const { ORDER_REFUSAL_CASES } = require('../anchor.test/helpers/bundle_order_cases.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

function firstChainOrderBreak(sections) {
    for (let i = 1; i < sections.length; i++) {
        if (sections[i - 1].chain >= sections[i].chain) return i;
    }
    return -1;
}

function firstPubkeyOrderBreak(sections) {
    for (let i = 0; i < sections.length; i++) {
        const sigs = sections[i].sigs || [];
        for (let j = 1; j < sigs.length; j++) {
            if (sigs[j - 1][0] >= sigs[j][0]) return i;
        }
    }
    return -1;
}

describe('ANCHOR bundle order refusal cases', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('pins the four names and refusal statuses', function () {
        assert.ok(Object.isFrozen(ORDER_REFUSAL_CASES));
        assert.deepStrictEqual(ORDER_REFUSAL_CASES.map(({ name, status }) => ({ name, status })), [
            { name: 'sections DOGE then BTC', status: 'invalid: SECTION 1 CHAIN (order)' },
            { name: 'sections BTC, LTC, DOGE', status: 'invalid: SECTION 2 CHAIN (order)' },
            { name: 'pairs B then A', status: 'invalid: SECTION 0 SIGS (order)' },
            { name: 'second section pairs B then A', status: 'invalid: SECTION 1 SIGS (order)' }
        ]);
    });

    it('pins JavaScript string ordering for chains and pubkeys', function () {
        assert.ok(PUBKEY_A < PUBKEY_B);
        assert.ok('BTC' < 'DOGE' && 'DOGE' < 'LTC');
    });

    it('names the first section whose chain or pubkey ordering breaks', function () {
        for (const testCase of ORDER_REFUSAL_CASES) {
            const match = testCase.status.match(/SECTION (\d+) (CHAIN|SIGS) \(order\)$/);
            assert.ok(match, testCase.name);
            const actual = match[2] === 'CHAIN'
                ? firstChainOrderBreak(testCase.sections)
                : firstPubkeyOrderBreak(testCase.sections);
            assert.strictEqual(actual, Number(match[1]), testCase.name);
        }
    });

    it('builds well-formed wires that parse on unarmed mainnet', async function () {
        handler.config['NETWORK'] = 'mainnet';
        indexer.config['NETWORK'] = 'mainnet';
        for (const testCase of ORDER_REFUSAL_CASES) {
            const data = createBaseData({
                ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: 70000000
            });
            await handler.parse(v0Params({ sections: testCase.sections, network: 'mainnet' }), data, null);
            assert.strictEqual(data['STATUS'], 'valid', testCase.name);
        }
    });
});
